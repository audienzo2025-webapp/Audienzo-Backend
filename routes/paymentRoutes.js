require('dotenv').config();
const express = require('express');
const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { sendWelcomeEmail, sendExpiryReminderEmail, sendUpgradeReminderEmail, sendInvoiceEmail } = require('../services/emailService');
const UsageAlertService = require('../services/usageAlertService');
const { calculateGST, createRazorpayInvoice } = require('../services/invoiceService');

const router = express.Router();

// Environment detection for frontend URL
const isProduction = process.env.NODE_ENV === 'production';
const frontendUrl = isProduction ? process.env.FRONTEND_URL : 'http://localhost:4200';

// Helper function to get plan display name
const getPlanDisplayName = (planId) => {
  const planNames = {
    'free': 'Free',
    'entry': 'Entry',
    'business': 'Business',
    'enterprise': 'Enterprise',
    'custom': 'Custom'
  };
  return planNames[planId] || 'Unknown Plan';
};

const isSameDay = (dateA, dateB) => {
  if (!dateA || !dateB) return false;
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
};

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Create Razorpay order
const createPaymentSession = async (planId, currency, basePrice, planName, userEmail) => {
  try {
    // Calculate GST and total amount
    const pricing = calculateGST(basePrice, currency);
    
    // Convert total amount to paise (Razorpay expects amount in smallest currency unit)
    const amountInPaise = Math.round(pricing.totalAmount * 100);
    
    const options = {
      amount: amountInPaise,
      currency: currency,
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      notes: {
        planId: planId,
        planName: planName,
        userEmail: userEmail,
        basePrice: pricing.basePrice.toString(),
        gstAmount: pricing.gstAmount.toString(),
        totalAmount: pricing.totalAmount.toString()
      }
    };

    const order = await razorpay.orders.create(options);
    
    return {
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      pricing: pricing // Include pricing breakdown
    };
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Create payment session
router.post('/create-session', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const { planId, currency, amount, planName } = req.body;
    
    // Validate required fields
    if (!planId || !currency || amount === undefined) {
      return res.status(400).json({ error: 'Missing required payment details' });
    }

    // Validate plan ID
    const validPlans = ['entry', 'business', 'enterprise', 'custom'];
    if (!validPlans.includes(planId)) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    // Validate currency
    const validCurrencies = ['INR', 'USD'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({ error: 'Invalid currency' });
    }

    // Get user email
    const user = await User.findById(getAuthUser(req)._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Note: 'amount' from frontend is the base price
    // We'll calculate GST and total here
    const basePrice = parseFloat(amount);

    // Create Razorpay order with GST calculation
    const paymentSession = await createPaymentSession(
      planId,
      currency,
      basePrice,
      planName,
      user.email
    );

    if (paymentSession.success) {
      // Store payment session in user's session with pricing breakdown
      req.session.pendingPayment = {
        orderId: paymentSession.orderId,
        planId,
        currency,
        basePrice: paymentSession.pricing.basePrice,
        gstAmount: paymentSession.pricing.gstAmount,
        totalAmount: paymentSession.pricing.totalAmount,
        planName,
        userEmail: user.email,
        createdAt: new Date()
      };

      res.json({
        success: true,
        orderId: paymentSession.orderId,
        amount: paymentSession.amount, // Total amount including GST
        currency: paymentSession.currency,
        keyId: paymentSession.keyId,
        pricing: paymentSession.pricing // Include pricing breakdown for frontend display
      });
    } else {
      res.status(500).json({ error: paymentSession.error || 'Failed to create payment session' });
    }
  } catch (error) {
    console.error('Error creating payment session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle payment success callback
router.post('/success', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const { orderId, paymentId, signature } = req.body;
    
    // Verify Razorpay payment signature
    const isPaymentValid = await verifyPayment(orderId, paymentId, signature);
    
    if (isPaymentValid) {
      const pendingPayment = req.session.pendingPayment;
      
      // Check if we have pending payment in session OR if order ID matches
      if (pendingPayment && pendingPayment.orderId === orderId) {
        // Calculate subscription end date based on plan
        const now = new Date();
        let subscriptionEndDate;
        let purchasedEventCount = 0;
        let eventBundleType = null;
      
        if (pendingPayment.planId === 'entry') {
          // Entry plan: per-event model - determine event count from amount
          // Single event: ₹399, 3 events: ₹1,099, 5 events: ₹1,699
          const basePrice = pendingPayment.basePrice || (pendingPayment.totalAmount / 1.18);
          if (basePrice >= 1699) {
            purchasedEventCount = 5;
            eventBundleType = '5-events';
          } else if (basePrice >= 1099) {
            purchasedEventCount = 3;
            eventBundleType = '3-events';
          } else {
            purchasedEventCount = 1;
            eventBundleType = 'single';
          }
          // Entry plan doesn't have a fixed subscription period - events are purchased
          // Set a long expiry date (e.g., 1 year) but track by purchasedEventCount
          subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        } else if (pendingPayment.planId === 'business' || pendingPayment.planId === 'enterprise') {
          // Business and Enterprise plans: annual, so end date is 1 year from now
          subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        } else {
          // Default: 1 year from now
          subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        }

        // Check if user already has an active paid plan
        const currentUser = await User.findById(getAuthUser(req)._id);
        const hasActivePaidPlan = currentUser && 
          currentUser.subscriptionStatus === 'active' && 
          currentUser.selectedPlan && 
          currentUser.selectedPlan !== 'free' &&
          currentUser.subscriptionEndDate && 
          new Date(currentUser.subscriptionEndDate) > new Date();

        let user;
        if (hasActivePaidPlan) {
          // User has an active paid plan, set new plan as upcoming
          const upcomingPlan = {
            planId: pendingPayment.planId,
            currency: pendingPayment.currency,
            validityPeriod: pendingPayment.planId === 'entry' ? 'Per-event purchase' : (pendingPayment.planId === 'business' ? '1 year' : '1 year'),
            amount: pendingPayment.amount,
            scheduledAt: new Date(),
            status: 'scheduled',
            paymentId: paymentId
          };

          user = await User.findByIdAndUpdate(
            getAuthUser(req)._id,
            { upcomingPlan: upcomingPlan },
            { new: true }
          );
        } else {
          // No active paid plan, activate immediately
          const updateData = {
            selectedPlan: pendingPayment.planId,
            planCurrency: pendingPayment.currency,
            planSelectedAt: new Date(),
            paymentId: paymentId,
            paymentStatus: 'completed',
            lastPaymentDate: new Date(),
            subscriptionStatus: 'active',
            subscriptionEndDate: subscriptionEndDate,
            autoRenewal: true // Enable auto-renewal by default for new subscriptions
          };

          // For Entry plan, add purchased event count
          if (pendingPayment.planId === 'entry') {
            // If user already has purchased events, add to existing count
            const currentUser = await User.findById(getAuthUser(req)._id);
            const existingCount = currentUser?.purchasedEventCount || 0;
            updateData.purchasedEventCount = existingCount + purchasedEventCount;
            updateData.eventBundleType = eventBundleType;
          }

          user = await User.findByIdAndUpdate(
            getAuthUser(req)._id,
            updateData,
            { new: true }
          );
        }

        // Reset usage alert counts for new/upgraded plan
        try {
          await UsageAlertService.resetAlertCounts(user._id);
        } catch (alertResetError) {
          console.error('❌ Failed to reset usage alert counts:', alertResetError);
          // Don't fail the payment process if alert reset fails
        }

        // Create Razorpay invoice after successful payment
        let invoiceResult = null;
        try {
          const basePrice = pendingPayment.basePrice || (pendingPayment.totalAmount / 1.18); // Fallback calculation if basePrice not stored
          const gstAmount = pendingPayment.gstAmount || (pendingPayment.totalAmount - basePrice);
          const totalAmount = pendingPayment.totalAmount || (basePrice + gstAmount);
          
          invoiceResult = await createRazorpayInvoice({
            customer: {
              name: user.fullName || 'Customer',
              email: user.email,
              phone: user.phone || '',
              billingAddress: user.billingAddress || {}
            },
            planName: pendingPayment.planName || getPlanDisplayName(pendingPayment.planId),
            basePrice: basePrice,
            gstAmount: gstAmount,
            totalAmount: totalAmount,
            currency: pendingPayment.currency,
            paymentId: paymentId
          });

          if (invoiceResult.success) {
            // Store invoice ID in user record
            await User.findByIdAndUpdate(
              getAuthUser(req)._id,
              {
                invoiceId: invoiceResult.invoiceId,
                lastInvoiceId: invoiceResult.invoiceId
              }
            );
            console.log('✅ Invoice created successfully:', invoiceResult.invoiceId);
          } else {
            console.error('❌ Failed to create invoice:', invoiceResult.error);
            if (invoiceResult.errorDetails) {
              console.error('   Error Details:', JSON.stringify(invoiceResult.errorDetails, null, 2));
            }
          }
        } catch (invoiceError) {
          console.error('❌ Error creating invoice:', invoiceError);
          console.error('   Stack:', invoiceError.stack);
          // Don't fail the payment process if invoice creation fails
        }

        // Send welcome email with invoice details ONLY if plan is activated immediately (not upcoming)
        if (!hasActivePaidPlan) {
          try {
            const planName = getPlanDisplayName(pendingPayment.planId);
            const basePrice = pendingPayment.basePrice || (pendingPayment.totalAmount / 1.18);
            const gstAmount = pendingPayment.gstAmount || (pendingPayment.totalAmount - basePrice);
            const totalAmount = pendingPayment.totalAmount || (basePrice + gstAmount);
            
            // Prepare invoice details for welcome email
            const invoiceDetails = invoiceResult && invoiceResult.success ? {
              invoiceId: invoiceResult.invoiceId,
              invoiceUrl: invoiceResult.invoiceUrl || null,
              basePrice: basePrice,
              gstAmount: gstAmount,
              totalAmount: totalAmount
            } : null;
            
            await sendWelcomeEmail(
              {
                fullName: user.fullName,
                email: user.email
              },
              pendingPayment.planId,
              planName,
              pendingPayment.currency,
              new Date(),
              subscriptionEndDate,
              invoiceDetails
            );
            console.log('✅ Welcome email with invoice sent successfully');
          } catch (emailError) {
            console.error('Failed to send welcome email:', emailError);
            // Don't fail the payment process if email fails
          }
        }

        // Clear pending payment
        delete req.session.pendingPayment;
        
        // Update session user data
        req.session.user = user;

        res.json({
          success: true,
          message: hasActivePaidPlan ? 
            'Payment successful! Plan will be activated after your current plan expires.' : 
            'Payment successful and plan activated',
          planId: pendingPayment.planId,
          isUpcoming: hasActivePaidPlan,
          invoiceId: invoiceResult?.invoiceId || null,
          invoiceUrl: invoiceResult?.invoiceUrl || null
        });
      } else if (!pendingPayment || pendingPayment.orderId !== orderId) {
        // Try to fetch order details from Razorpay API as fallback
        try {
          const order = await razorpay.orders.fetch(orderId);
          
          // Extract plan details from order notes or fetch user's recent order
          const user = await User.findById(getAuthUser(req)._id);
          if (!user) {
            return res.status(404).json({ error: 'User not found' });
          }
          
          // Try to determine plan from user's recent activity or use notes from Razorpay order
          const planFromNotes = order.notes?.planId || 'entry'; // Fallback to entry
          const totalAmount = order.amount / 100; // Convert from paise to rupees
          
          // Extract pricing from order notes or calculate
          const basePrice = order.notes?.basePrice ? parseFloat(order.notes.basePrice) : (totalAmount / 1.18);
          const gstAmount = order.notes?.gstAmount ? parseFloat(order.notes.gstAmount) : (totalAmount - basePrice);
          
          // Create pending payment object from order
          const orderBasedPayment = {
            orderId: orderId,
            planId: planFromNotes,
            currency: order.currency,
            basePrice: basePrice,
            gstAmount: gstAmount,
            totalAmount: totalAmount,
            planName: order.notes?.planName || 'Plan',
            userEmail: user.email
          };
          
          // Continue with payment processing using order-based data
          const now = new Date();
          let subscriptionEndDate;
          
          let purchasedEventCount = 0;
          let eventBundleType = null;

          if (planFromNotes === 'entry') {
            // Entry plan: per-event model - determine event count from amount
            const basePrice = orderBasedPayment.basePrice || (totalAmount / 1.18);
            if (basePrice >= 1699) {
              purchasedEventCount = 5;
              eventBundleType = '5-events';
            } else if (basePrice >= 1099) {
              purchasedEventCount = 3;
              eventBundleType = '3-events';
            } else {
              purchasedEventCount = 1;
              eventBundleType = 'single';
            }
            // Entry plan doesn't have a fixed subscription period
            subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
          } else if (planFromNotes === 'business' || planFromNotes === 'enterprise') {
            subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
          } else {
            subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
          }

          const currentUser = await User.findById(getAuthUser(req)._id);
          const hasActivePaidPlan = currentUser && 
            currentUser.subscriptionStatus === 'active' && 
            currentUser.selectedPlan && 
            currentUser.selectedPlan !== 'free' &&
            currentUser.subscriptionEndDate && 
            new Date(currentUser.subscriptionEndDate) > new Date();

          let updatedUser;
          if (hasActivePaidPlan) {
            const upcomingPlan = {
              planId: orderBasedPayment.planId,
              currency: orderBasedPayment.currency,
              validityPeriod: orderBasedPayment.planId === 'entry' ? 'Per-event purchase' : (orderBasedPayment.planId === 'business' ? '1 year' : '1 year'),
              amount: orderBasedPayment.totalAmount,
              scheduledAt: new Date(),
              status: 'scheduled',
              paymentId: paymentId
            };

            updatedUser = await User.findByIdAndUpdate(
              getAuthUser(req)._id,
              { upcomingPlan: upcomingPlan },
              { new: true }
            );
          } else {
            const updateData = {
              selectedPlan: orderBasedPayment.planId,
              planCurrency: orderBasedPayment.currency,
              planSelectedAt: new Date(),
              paymentId: paymentId,
              paymentStatus: 'completed',
              lastPaymentDate: new Date(),
              subscriptionStatus: 'active',
              subscriptionEndDate: subscriptionEndDate,
              autoRenewal: true
            };

            // For Entry plan, add purchased event count
            if (planFromNotes === 'entry') {
              const existingCount = currentUser?.purchasedEventCount || 0;
              updateData.purchasedEventCount = existingCount + purchasedEventCount;
              updateData.eventBundleType = eventBundleType;
            }

            updatedUser = await User.findByIdAndUpdate(
              getAuthUser(req)._id,
              updateData,
              { new: true }
            );
          }

          // Reset usage alert counts
          try {
            await UsageAlertService.resetAlertCounts(updatedUser._id);
          } catch (alertResetError) {
            console.error('❌ Failed to reset usage alert counts:', alertResetError);
          }

          // Create Razorpay invoice after successful payment
          let invoiceResult = null;
          try {
            invoiceResult = await createRazorpayInvoice({
              customer: {
                name: updatedUser.fullName || 'Customer',
                email: updatedUser.email,
                phone: updatedUser.phone || '',
                billingAddress: updatedUser.billingAddress || {}
              },
              planName: orderBasedPayment.planName || getPlanDisplayName(orderBasedPayment.planId),
              basePrice: orderBasedPayment.basePrice,
              gstAmount: orderBasedPayment.gstAmount,
              totalAmount: orderBasedPayment.totalAmount,
              currency: orderBasedPayment.currency,
              paymentId: paymentId
            });

            if (invoiceResult.success) {
              // Store invoice ID in user record
              await User.findByIdAndUpdate(
                getAuthUser(req)._id,
                {
                  invoiceId: invoiceResult.invoiceId,
                  lastInvoiceId: invoiceResult.invoiceId
                }
              );
              console.log('✅ Invoice created successfully:', invoiceResult.invoiceId);
            } else {
              console.error('❌ Failed to create invoice:', invoiceResult.error);
              if (invoiceResult.errorDetails) {
                console.error('   Error Details:', JSON.stringify(invoiceResult.errorDetails, null, 2));
              }
            }
          } catch (invoiceError) {
            console.error('❌ Error creating invoice:', invoiceError);
            console.error('   Stack:', invoiceError.stack);
            // Don't fail the payment process if invoice creation fails
          }

          // Send welcome email with invoice details ONLY if plan is activated immediately (not upcoming)
          if (!hasActivePaidPlan) {
            try {
              const planName = getPlanDisplayName(orderBasedPayment.planId);
              
              // Prepare invoice details for welcome email
              const invoiceDetails = invoiceResult && invoiceResult.success ? {
                invoiceId: invoiceResult.invoiceId,
                invoiceUrl: invoiceResult.invoiceUrl || null,
                basePrice: orderBasedPayment.basePrice,
                gstAmount: orderBasedPayment.gstAmount,
                totalAmount: orderBasedPayment.totalAmount
              } : null;
              
              await sendWelcomeEmail(
                {
                  fullName: updatedUser.fullName,
                  email: updatedUser.email
                },
                orderBasedPayment.planId,
                planName,
                orderBasedPayment.currency,
                new Date(),
                subscriptionEndDate,
                invoiceDetails
              );
              console.log('✅ Welcome email with invoice sent successfully');
            } catch (emailError) {
              console.error('Failed to send welcome email:', emailError);
              // Don't fail the payment process if email fails
            }
          }

          req.session.user = updatedUser;

          res.json({
            success: true,
            message: hasActivePaidPlan ? 
              'Payment successful! Plan will be activated after your current plan expires.' : 
              'Payment successful and plan activated',
            planId: orderBasedPayment.planId,
            isUpcoming: hasActivePaidPlan,
            invoiceId: invoiceResult?.invoiceId || null,
            invoiceUrl: invoiceResult?.invoiceUrl || null
          });
          
        } catch (razorpayError) {
          console.error('Error fetching order from Razorpay:', razorpayError);
          res.status(400).json({ error: 'Invalid payment session and failed to fetch order details' });
        }
      } else {
        res.status(400).json({ error: 'Invalid payment session' });
      }
    } else {
      res.status(400).json({ error: 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Error processing payment success:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle payment failure callback
router.post('/failure', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const { orderId, error: paymentError } = req.body;
    
    // Clear pending payment
    if (req.session.pendingPayment && req.session.pendingPayment.orderId === orderId) {
      delete req.session.pendingPayment;
    }

    res.json({
      success: false,
      message: 'Payment failed',
      error: paymentError
    });
  } catch (error) {
    console.error('Error processing payment failure:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Razorpay payment verification
const verifyPayment = async (orderId, paymentId, signature) => {
  try {
    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    
    return expectedSignature === signature;
  } catch (error) {
    console.error('Error verifying payment:', error);
    return false;
  }
};

// Get payment status
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const pendingPayment = req.session.pendingPayment;
    
    if (pendingPayment && pendingPayment.orderId === orderId) {
      res.json({
        success: true,
        status: 'pending',
        planId: pendingPayment.planId,
        amount: pendingPayment.amount,
        currency: pendingPayment.currency
      });
    } else {
      res.json({
        success: true,
        status: 'not_found'
      });
    }
  } catch (error) {
    console.error('Error getting payment status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get subscription status for a user
router.get('/subscription-status/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const subscription = {
      planId: user.selectedPlan || 'free',
      planCurrency: user.planCurrency || 'INR',
      planSelectedAt: user.planSelectedAt,
      paymentStatus: user.paymentStatus,
      lastPaymentDate: user.lastPaymentDate,
      usageStats: user.usageStats
    };

    res.json({
      success: true,
      subscription: subscription
    });
  } catch (error) {
    console.error('Error getting subscription status:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving subscription status'
    });
  }
});

// Check and send reminder emails for all users
router.post('/send-reminder-emails', async (req, res) => {
  try {
    const now = new Date();
    
    let emailsSent = 0;
    let errors = [];

    // Get all users with active subscriptions
    const users = await User.find({
      $or: [
        { selectedPlan: { $in: ['entry', 'enterprise', 'custom'] } },
        { selectedPlan: 'free' }
      ]
    });

    for (const user of users) {
      try {
        // Check if user has renewal reminders enabled
        const renewalRemindersEnabled = user.notificationSettings?.emailRenewal !== false; // Default to true if not set
        
        if (!renewalRemindersEnabled) {
          continue;
        }

        user.reminderTracking = user.reminderTracking || {};
        const reminderTracking = user.reminderTracking;

        if (user.selectedPlan === 'free') {
          // Check if free plan user should get upgrade reminder (2 days before plan selection date + 30 days)
          if (user.planSelectedAt) {
            const thirtyDaysFromSelection = new Date(user.planSelectedAt.getTime() + (30 * 24 * 60 * 60 * 1000));
            const twoDaysBeforeUpgrade = new Date(thirtyDaysFromSelection.getTime() - (2 * 24 * 60 * 60 * 1000));
            
            // Check if today is 2 days before the upgrade reminder date
            if (
              now.toDateString() === twoDaysBeforeUpgrade.toDateString() &&
              !isSameDay(reminderTracking.lastUpgradeTargetDate, twoDaysBeforeUpgrade)
            ) {
              await sendUpgradeReminderEmail(
                {
                  fullName: user.fullName,
                  email: user.email
                },
                user.planSelectedAt
              );
              emailsSent++;
              reminderTracking.lastUpgradeSentOn = now;
              reminderTracking.lastUpgradeTargetDate = twoDaysBeforeUpgrade;
              await user.save();
            }
          }
        } else {
          // Check if paid plan user should get expiry reminder (7 days before expiry)
          if (user.subscriptionEndDate) {
            const sevenDaysBeforeExpiry = new Date(user.subscriptionEndDate.getTime() - (7 * 24 * 60 * 60 * 1000));
            
            // Check if today is 7 days before expiry
            if (
              now.toDateString() === sevenDaysBeforeExpiry.toDateString() &&
              !isSameDay(reminderTracking.lastExpiryTargetDate, sevenDaysBeforeExpiry)
            ) {
              const planName = getPlanDisplayName(user.selectedPlan);
              const remainingDays = Math.ceil((user.subscriptionEndDate - now) / (1000 * 60 * 60 * 24));
              
              await sendExpiryReminderEmail(
                {
                  fullName: user.fullName,
                  email: user.email
                },
                user.selectedPlan,
                planName,
                user.subscriptionEndDate,
                remainingDays
              );
              emailsSent++;
              reminderTracking.lastExpirySentOn = now;
              reminderTracking.lastExpiryTargetDate = sevenDaysBeforeExpiry;
              await user.save();
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error sending reminder email to ${user.email}:`, error);
        errors.push({
          email: user.email,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Reminder emails processed. ${emailsSent} emails sent successfully.`,
      emailsSent,
      errors: errors.length > 0 ? errors : null
    });
  } catch (error) {
    console.error('Error processing reminder emails:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing reminder emails',
      error: error.message
    });
  }
});

// Manual trigger for testing reminder emails (for specific user)
router.post('/send-test-reminder/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { type } = req.body; // 'expiry' or 'upgrade'
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (type === 'expiry' && user.selectedPlan !== 'free') {
      // Send expiry reminder for paid plans
      const planName = getPlanDisplayName(user.selectedPlan);
      const remainingDays = user.subscriptionEndDate ? 
        Math.ceil((user.subscriptionEndDate - new Date()) / (1000 * 60 * 60 * 24)) : 7;
      
      await sendExpiryReminderEmail(
        {
          fullName: user.fullName,
          email: user.email
        },
        user.selectedPlan,
        planName,
        user.subscriptionEndDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        remainingDays
      );
      
      res.json({
        success: true,
        message: `Expiry reminder sent to ${email}`
      });
    } else if (type === 'upgrade' && user.selectedPlan === 'free') {
      // Send upgrade reminder for free plans
      await sendUpgradeReminderEmail(
        {
          fullName: user.fullName,
          email: user.email
        },
        user.planSelectedAt || new Date()
      );
      
      res.json({
        success: true,
        message: `Upgrade reminder sent to ${email}`
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Invalid reminder type for user plan'
      });
    }
  } catch (error) {
    console.error('Error sending test reminder:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending test reminder',
      error: error.message
    });
  }
});

// Get user invoices
router.get('/invoices', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const user = await User.findById(getAuthUser(req)._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get invoice IDs from user record
    const invoiceIds = [];
    if (user.invoiceId) invoiceIds.push(user.invoiceId);
    if (user.lastInvoiceId && user.lastInvoiceId !== user.invoiceId) {
      invoiceIds.push(user.lastInvoiceId);
    }

    // Fetch invoice details from Razorpay
    const invoices = [];
    for (const invoiceId of invoiceIds) {
      try {
        const invoice = await razorpay.invoices.fetch(invoiceId);
        invoices.push({
          id: invoice.id,
          invoiceNumber: invoice.number || invoice.id,
          amount: invoice.amount / 100, // Convert from paise
          currency: invoice.currency,
          status: invoice.status,
          issueDate: invoice.created_at ? new Date(invoice.created_at * 1000) : null,
          dueDate: invoice.expired_at ? new Date(invoice.expired_at * 1000) : null,
          description: invoice.description,
          customerName: invoice.customer_details?.name || 'Customer',
          customerEmail: invoice.customer_details?.email || user.email,
          url: invoice.short_url || null,
          pdfUrl: `https://api.razorpay.com/v1/invoices/${invoice.id}/pdf`
        });
      } catch (invoiceError) {
        console.error(`Error fetching invoice ${invoiceId}:`, invoiceError);
        // Continue with other invoices
      }
    }

    // Sort invoices by issue date (newest first)
    invoices.sort((a, b) => {
      const dateA = a.issueDate || new Date(0);
      const dateB = b.issueDate || new Date(0);
      return dateB - dateA;
    });

    res.json({
      success: true,
      invoices: invoices
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
