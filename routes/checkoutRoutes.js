require('dotenv').config();
const express = require('express');
const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { calculateGST, createRazorpayInvoice } = require('../services/invoiceService');
const { sendInvoiceEmail } = require('../services/emailService');

const router = express.Router();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Get subscription status for a user (matching frontend expectation)
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

// Get upcoming plan for a user
router.get('/upcoming-plan/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if user has an upcoming plan
    if (user.upcomingPlan) {
      res.json({
        success: true,
        upcomingPlan: user.upcomingPlan
      });
    } else {
      res.json({
        success: true,
        upcomingPlan: null
      });
    }
  } catch (error) {
    console.error('Error getting upcoming plan:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving upcoming plan'
    });
  }
});

// Set upcoming plan for a user
router.post('/set-upcoming-plan', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not logged in' 
      });
    }

    const { planId, currency } = req.body;
    
    // Validate required fields
    if (!planId || !currency) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Validate plan ID
    const validPlans = ['free', 'entry', 'business', 'enterprise', 'custom'];
    if (!validPlans.includes(planId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan ID'
      });
    }

    // Validate currency
    const validCurrencies = ['INR', 'USD'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid currency'
      });
    }

    const user = await User.findById(getAuthUser(req)._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Calculate plan validity period
    let validityPeriod;
    switch (planId) {
      case 'free':
        validityPeriod = '1 month';
        break;
      case 'entry':
        validityPeriod = 'Per-event purchase';
        break;
      case 'business':
      case 'enterprise':
      case 'custom':
        validityPeriod = '1 year';
        break;
      default:
        validityPeriod = 'Unknown';
    }

    // Calculate plan amount
    let amount = 0;
    if (planId === 'entry') {
      amount = 399; // Per event (default single event)
    } else if (planId === 'business') {
      amount = 6999;
    } else if (planId === 'enterprise') {
      amount = 39999;
    }

    // Set upcoming plan
    const upcomingPlan = {
      planId,
      currency,
      validityPeriod,
      amount: planId === 'free' ? 0 : amount,
      scheduledAt: new Date(),
      status: 'scheduled'
    };

    await User.findByIdAndUpdate(
      getAuthUser(req)._id,
      { upcomingPlan: upcomingPlan },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Upcoming plan set successfully',
      upcomingPlan: upcomingPlan
    });
  } catch (error) {
    console.error('Error setting upcoming plan:', error);
    res.status(500).json({
      success: false,
      message: 'Error setting upcoming plan'
    });
  }
});

// Apply upcoming plan immediately
router.post('/apply-upcoming-plan', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not logged in' 
      });
    }

    const { email, upcomingPlanId } = req.body;
    
    const user = await User.findById(getAuthUser(req)._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.upcomingPlan) {
      return res.status(400).json({
        success: false,
        message: 'No upcoming plan found'
      });
    }

    // Calculate subscription end date based on upcoming plan
    const now = new Date();
    let subscriptionEndDate;
    let purchasedEventCount = 0;
    let eventBundleType = null;
    
    switch (user.upcomingPlan.planId) {
      case 'free':
        subscriptionEndDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000)); // 1 month
        break;
      case 'entry':
        // Entry plan: per-event model - determine event count from amount
        const basePrice = user.upcomingPlan.amount || 399;
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
        break;
      case 'business':
      case 'enterprise':
      case 'custom':
        subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000)); // 1 year
        break;
      default:
        subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
    }

    // Prepare update data
    const updateData = {
      selectedPlan: user.upcomingPlan.planId,
      planCurrency: user.upcomingPlan.currency,
      planSelectedAt: new Date(),
      subscriptionStatus: 'active',
      subscriptionEndDate: subscriptionEndDate,
      autoRenewal: true,
      $unset: { upcomingPlan: 1 } // Remove upcoming plan
    };

    // For Entry plan, add purchased event count
    if (user.upcomingPlan.planId === 'entry') {
      const existingCount = user.purchasedEventCount || 0;
      updateData.purchasedEventCount = existingCount + purchasedEventCount;
      updateData.eventBundleType = eventBundleType;
    }

    // Apply the upcoming plan
    const updatedUser = await User.findByIdAndUpdate(
      getAuthUser(req)._id,
      updateData,
      { new: true }
    );

    // Send welcome email when upcoming plan is activated
    try {
      const { sendWelcomeEmail } = require('../services/emailService');
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

      const planName = getPlanDisplayName(user.upcomingPlan.planId);
      await sendWelcomeEmail(
        {
          fullName: updatedUser.fullName,
          email: updatedUser.email
        },
        user.upcomingPlan.planId,
        planName,
        user.upcomingPlan.currency,
        new Date(), // Current activation date
        subscriptionEndDate
      );
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail the plan application if email fails
    }

    res.json({
      success: true,
      message: 'Upcoming plan applied successfully',
      subscription: {
        planId: updatedUser.selectedPlan,
        planCurrency: updatedUser.planCurrency,
        subscriptionEndDate: updatedUser.subscriptionEndDate
      }
    });
  } catch (error) {
    console.error('Error applying upcoming plan:', error);
    res.status(500).json({
      success: false,
      message: 'Error applying upcoming plan'
    });
  }
});

// Cancel upcoming plan
router.post('/cancel-upcoming-plan', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not logged in' 
      });
    }

    const user = await User.findById(getAuthUser(req)._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.upcomingPlan) {
      return res.status(400).json({
        success: false,
        message: 'No upcoming plan found'
      });
    }

    // Remove upcoming plan
    await User.findByIdAndUpdate(
      getAuthUser(req)._id,
      { $unset: { upcomingPlan: 1 } },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Upcoming plan cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling upcoming plan:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling upcoming plan'
    });
  }
});

// Create payment session for upcoming plan
router.post('/create-upcoming-plan-session', async (req, res) => {
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

    // Calculate GST and total amount
    const pricing = calculateGST(basePrice, currency);

    // Create Razorpay order
    const options = {
      amount: Math.round(pricing.totalAmount * 100), // Convert total to paise
      currency: currency,
      receipt: `upcoming_${planId}_${Date.now()}`,
      notes: {
        planId: planId,
        planName: planName,
        userEmail: user.email,
        type: 'upcoming_plan',
        basePrice: pricing.basePrice.toString(),
        gstAmount: pricing.gstAmount.toString(),
        totalAmount: pricing.totalAmount.toString()
      }
    };

    const order = await razorpay.orders.create(options);

    // Store payment session in user's session with pricing breakdown
    req.session.pendingUpcomingPayment = {
      orderId: order.id,
      planId,
      currency,
      basePrice: pricing.basePrice,
      gstAmount: pricing.gstAmount,
      totalAmount: pricing.totalAmount,
      planName,
      userEmail: user.email,
      createdAt: new Date()
    };

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount, // Total amount including GST
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      pricing: pricing // Include pricing breakdown for frontend display
    });
  } catch (error) {
    console.error('Error creating upcoming plan payment session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle upcoming plan payment success
router.post('/upcoming-plan-success', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const { orderId, paymentId, signature } = req.body;
    
    // Verify Razorpay payment signature
    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isPaymentValid = expectedSignature === signature;
    
    if (isPaymentValid) {
      const pendingPayment = req.session.pendingUpcomingPayment;
      
      if (pendingPayment && pendingPayment.orderId === orderId) {
        // Calculate plan validity period
        let validityPeriod;
        switch (pendingPayment.planId) {
          case 'entry':
            validityPeriod = 'Per-event purchase';
            break;
          case 'business':
          case 'enterprise':
          case 'custom':
            validityPeriod = '1 year';
            break;
          default:
            validityPeriod = 'Unknown';
        }

        // Get user for invoice creation
        const user = await User.findById(getAuthUser(req)._id);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Set upcoming plan
        const upcomingPlan = {
          planId: pendingPayment.planId,
          currency: pendingPayment.currency,
          validityPeriod,
          amount: pendingPayment.totalAmount,
          scheduledAt: new Date(),
          status: 'scheduled',
          paymentId: paymentId
        };

        const updatedUser = await User.findByIdAndUpdate(
          getAuthUser(req)._id,
          { upcomingPlan: upcomingPlan },
          { new: true }
        );

        // Create Razorpay invoice after successful payment for upcoming plan
        let invoiceResult = null;
        try {
          const getPlanDisplayName = (planId) => {
            const planNames = {
              'free': 'Free',
              'entry': 'Entry',
              'enterprise': 'Enterprise',
              'custom': 'Custom'
            };
            return planNames[planId] || 'Unknown Plan';
          };

          invoiceResult = await createRazorpayInvoice({
            customer: {
              name: user.fullName || 'Customer',
              email: user.email,
              phone: user.phone || '',
              billingAddress: user.billingAddress || {}
            },
            planName: pendingPayment.planName || getPlanDisplayName(pendingPayment.planId),
            basePrice: pendingPayment.basePrice || (pendingPayment.totalAmount / 1.18),
            gstAmount: pendingPayment.gstAmount || (pendingPayment.totalAmount - (pendingPayment.totalAmount / 1.18)),
            totalAmount: pendingPayment.totalAmount,
            currency: pendingPayment.currency,
            paymentId: paymentId
          });

          if (invoiceResult.success) {
            // Store invoice ID in user record (for upcoming plan invoices)
            await User.findByIdAndUpdate(
              getAuthUser(req)._id,
              {
                lastInvoiceId: invoiceResult.invoiceId
              }
            );
            console.log('✅ Invoice created successfully for upcoming plan:', invoiceResult.invoiceId);
            
            // Send invoice email for upcoming plan (no welcome email since plan isn't activated yet)
            try {
              await sendInvoiceEmail(
                {
                  fullName: user.fullName,
                  email: user.email
                },
                invoiceResult.invoiceId,
                invoiceResult.invoiceUrl || null,
                pendingPayment.planName || getPlanDisplayName(pendingPayment.planId),
                pendingPayment.basePrice || (pendingPayment.totalAmount / 1.18),
                pendingPayment.gstAmount || (pendingPayment.totalAmount - (pendingPayment.totalAmount / 1.18)),
                pendingPayment.totalAmount,
                pendingPayment.currency,
                new Date()
              );
              console.log('✅ Invoice email sent successfully for upcoming plan');
            } catch (invoiceEmailError) {
              console.error('❌ Failed to send invoice email:', invoiceEmailError);
              // Don't fail the payment process if email fails
            }
          } else {
            console.error('❌ Failed to create invoice:', invoiceResult.error);
            if (invoiceResult.errorDetails) {
              console.error('   Error Details:', JSON.stringify(invoiceResult.errorDetails, null, 2));
            }
          }
        } catch (invoiceError) {
          console.error('❌ Error creating invoice:', invoiceError);
          // Don't fail the payment process if invoice creation fails
        }

        // Clear pending payment
        delete req.session.pendingUpcomingPayment;

        res.json({
          success: true,
          message: 'Upcoming plan payment successful',
          upcomingPlan: upcomingPlan,
          invoiceId: invoiceResult?.invoiceId || null,
          invoiceUrl: invoiceResult?.invoiceUrl || null
        });
      } else {
        res.status(400).json({ error: 'Invalid payment session' });
      }
    } else {
      res.status(400).json({ error: 'Invalid payment signature' });
    }
  } catch (error) {
    console.error('Error handling upcoming plan payment success:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

