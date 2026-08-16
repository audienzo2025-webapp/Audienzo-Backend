const Razorpay = require('razorpay');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/**
 * Calculate GST amount and total
 * @param {number} basePrice - Base price of the plan
 * @param {string} currency - Currency code (INR or USD)
 * @returns {object} Object with basePrice, gstAmount, and totalAmount
 */
const calculateGST = (basePrice, currency = 'INR') => {
  // GST is 18% for INR, 0% for USD (or adjust as needed)
  const gstRate = currency === 'INR' ? 0.18 : 0;
  
  const basePriceNum = typeof basePrice === 'string' ? parseFloat(basePrice) : basePrice;
  const gstAmount = basePriceNum * gstRate;
  const totalAmount = basePriceNum + gstAmount;
  
  return {
    basePrice: Math.round(basePriceNum * 100) / 100, // Round to 2 decimal places
    gstRate: gstRate * 100, // Convert to percentage
    gstAmount: Math.round(gstAmount * 100) / 100,
    totalAmount: Math.round(totalAmount * 100) / 100
  };
};


/**
 * Create Razorpay invoice with email/SMS notifications
 * @param {object} invoiceData - Invoice data
 * @param {object} invoiceData.customer - Customer details
 * @param {string} invoiceData.customer.name - Customer name
 * @param {string} invoiceData.customer.email - Customer email
 * @param {string} invoiceData.customer.phone - Customer phone
 * @param {object} invoiceData.customer.billingAddress - Billing address
 * @param {string} invoiceData.planName - Plan name
 * @param {number} invoiceData.basePrice - Base price
 * @param {number} invoiceData.gstAmount - GST amount
 * @param {number} invoiceData.totalAmount - Total amount (base + GST)
 * @param {string} invoiceData.currency - Currency code
 * @param {string} invoiceData.paymentId - Payment ID
 * @returns {Promise<object>} Created invoice object with PDF path
 */
const createRazorpayInvoice = async (invoiceData) => {
  try {
    const { customer, planName, basePrice, gstAmount, totalAmount, currency, paymentId } = invoiceData;
    
    console.log('📄 Creating Razorpay invoice...');
    console.log('   Plan:', planName);
    console.log('   Base Price:', basePrice);
    console.log('   GST Amount:', gstAmount);
    console.log('   Total Amount:', totalAmount);
    console.log('   Currency:', currency);
    console.log('   Customer:', customer.email);
    
    // Convert amounts to smallest currency unit (paise for INR, cents for USD)
    const amountMultiplier = 100;
    const totalAmountInSmallestUnit = Math.round(totalAmount * amountMultiplier);
    const basePriceInSmallestUnit = Math.round(basePrice * amountMultiplier);
    const gstAmountInSmallestUnit = Math.round(gstAmount * amountMultiplier);
    
    // Build billing address (only include if it has meaningful data)
    const billingAddress = {};
    if (customer.billingAddress?.line1) billingAddress.line1 = customer.billingAddress.line1;
    if (customer.billingAddress?.line2) billingAddress.line2 = customer.billingAddress.line2;
    if (customer.billingAddress?.city) billingAddress.city = customer.billingAddress.city;
    if (customer.billingAddress?.state) billingAddress.state = customer.billingAddress.state;
    if (customer.billingAddress?.zipcode) billingAddress.zipcode = customer.billingAddress.zipcode;
    billingAddress.country = customer.billingAddress?.country || (currency === 'INR' ? 'IN' : 'US');
    
    // Create line items
    // Razorpay requires each line item to be at least INR 1.00 (100 paise)
    // So we combine items if GST is less than 100 paise to avoid validation errors
    const lineItems = [];
    const minAmountPaise = 100; // Minimum 100 paise (INR 1.00) per line item
    
    // If GST amount is >= 100 paise, show it as separate line item
    // Otherwise, combine into single line item with breakdown in description
    if (gstAmountInSmallestUnit >= minAmountPaise && basePriceInSmallestUnit >= minAmountPaise) {
      // Both amounts are >= 100 paise, show separately
      lineItems.push({
        name: `${planName} - Base Price`,
        description: `Subscription plan: ${planName} (Base Price)`,
        amount: basePriceInSmallestUnit,
        currency: currency,
        quantity: 1
      });
      
      lineItems.push({
        name: `GST @ 18%`,
        description: `GST (Goods and Services Tax) @ 18%`,
        amount: gstAmountInSmallestUnit,
        currency: currency,
        quantity: 1
      });
    } else {
      // One or both amounts are < 100 paise, combine into single line item
      // Include breakdown in description
      const breakdown = gstAmount > 0 
        ? `Base Price: ${currency === 'INR' ? '₹' : '$'}${basePrice.toFixed(2)}, GST @ 18%: ${currency === 'INR' ? '₹' : '$'}${gstAmount.toFixed(2)}`
        : '';
      
      lineItems.push({
        name: `${planName} - Subscription`,
        description: `Subscription plan: ${planName}${breakdown ? ` (${breakdown})` : ''}`,
        amount: totalAmountInSmallestUnit,
        currency: currency,
        quantity: 1
      });
    }
    
    // Ensure we have at least one line item
    if (lineItems.length === 0) {
      lineItems.push({
        name: `${planName} - Subscription`,
        description: `Subscription plan: ${planName}`,
        amount: totalAmountInSmallestUnit,
        currency: currency,
        quantity: 1
      });
    }
    
    // Validate all line items meet minimum amount requirement
    for (const item of lineItems) {
      if (item.amount < minAmountPaise) {
        console.warn(`⚠️ Line item "${item.name}" amount (${item.amount} paise) is less than minimum (${minAmountPaise} paise)`);
      }
    }
    
    // Create invoice payload with all required parameters
    const invoicePayload = {
      type: 'invoice',
      description: `Subscription Invoice for ${planName}`,
      customer: {
        name: customer.name || 'Customer',
        email: customer.email
      },
      line_items: lineItems,
      currency: currency,
      partial_payment: false,
      email_notify: 0, // Disable email notification (we send our own combined email)
      sms_notify: 0, // Disable SMS notification (optional - set to 1 if you want SMS)
      reminder_enable: true, // Enable payment reminders
      notes: {
        'Payment ID': paymentId || 'N/A',
        'Plan Name': planName,
        'GST Note': 'GST applicable as per government norms.',
        'Base Price': `${currency === 'INR' ? '₹' : '$'}${basePrice.toFixed(2)}`,
        'GST @ 18%': `${currency === 'INR' ? '₹' : '$'}${gstAmount.toFixed(2)}`,
        'Total Amount': `${currency === 'INR' ? '₹' : '$'}${totalAmount.toFixed(2)}`
      }
    };

    // Add contact (phone) if available - required for SMS notification
    if (customer.phone) {
      invoicePayload.customer.contact = customer.phone;
    } else {
      console.warn('⚠️ No phone number provided - SMS notification will not work');
    }

    // Add billing address if it has data
    if (Object.keys(billingAddress).length > 1 || billingAddress.country) {
      invoicePayload.customer.billing_address = billingAddress;
    }
    
    console.log('📤 Sending invoice creation request to Razorpay...');
    console.log('📋 Invoice Payload:', JSON.stringify(invoicePayload, null, 2));
    
    // Create invoice via Razorpay API
    const invoice = await razorpay.invoices.create(invoicePayload);
    
    console.log('✅ Invoice created in Razorpay:', invoice.id);
    console.log('   Invoice Status:', invoice.status);
    console.log('   Invoice Number:', invoice.number || invoice.id);
    console.log('   Invoice URL:', invoice.short_url);
    
    // Issue the invoice immediately
    if (invoice.id) {
      try {
        await razorpay.invoices.issue(invoice.id);
        console.log('✅ Invoice issued successfully');
      } catch (issueError) {
        console.error('❌ Could not issue invoice immediately:', issueError.message);
        console.error('   Full error:', issueError);
        // Continue anyway - invoice might still be usable
      }
    }
    
    return {
      success: true,
      invoice: invoice,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number || invoice.id,
      invoiceUrl: invoice.short_url || null
    };
  } catch (error) {
    console.error('❌ Error creating Razorpay invoice:', error);
    
    // Log detailed error information
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Status Text:', error.response.statusText);
      console.error('   Error Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('   Request made but no response received');
    } else {
      console.error('   Error Message:', error.message);
    }
    
    return {
      success: false,
      error: error.message || 'Failed to create invoice',
      errorDetails: error.response?.data || null
    };
  }
};

module.exports = {
  calculateGST,
  createRazorpayInvoice
};

