const puppeteer = require('puppeteer');
const otplib = require('otplib');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const fs = require('fs');
const axios = require('axios');
const { promisify } = require('util');

// Load environment variables
dotenv.config();

// Nodemailer for sending notifications
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendNotification = async (subject, message) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_RECEIVER,
    subject,
    text: message,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Notification sent');
  } catch (error) {
    console.error('Error sending notification:', error);
  }
};

// Utility: Delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to handle image CAPTCHA using 2Captcha API
async function handleCaptcha(base64Image) {
  try {
    const response = await axios.post('http://2captcha.com/in.php', null, {
      params: {
        key: process.env.TWOCAPTCHA_API_KEY,
        method: 'base64',
        body: base64Image,
        json: 1,
      },
    });

    const captchaId = response.data.request;
    console.log('CAPTCHA submitted, ID:', captchaId);

    // Wait for CAPTCHA to be solved
    await delay(20000); // Adjust wait time as needed
    const result = await axios.get('http://2captcha.com/res.php', {
      params: {
        key: process.env.TWOCAPTCHA_API_KEY,
        action: 'get',
        id: captchaId,
        json: 1,
      },
    });

    if (result.data.status === 1) {
      console.log('CAPTCHA solved:', result.data.request);
      return result.data.request; // Text solution to the CAPTCHA
    } else {
      throw new Error('Failed to solve CAPTCHA');
    }
  } catch (error) {
    console.error('Error solving CAPTCHA:', error);
    throw error;
  }
}

// Function to log in with 2FA and handle CAPTCHA
async function loginWith2FA(page) {
  try {
    await page.goto('https://www.amazon.com/ap/signin');

    // Enter email and password
    await page.type('#ap_email', process.env.AMAZON_EMAIL);
    await page.type('#ap_password', process.env.AMAZON_PASSWORD);
    await page.click('#signInSubmit');

    // Wait for the OTP page
    await page.waitForSelector('#auth-mfa-otpcode');

    // Generate OTP and submit
    const otpCode = otplib.authenticator.generate(process.env.OTP_SECRET);
    await page.type('#auth-mfa-otpcode', otpCode);
    await page.click('#auth-signin-button');

    // Handle CAPTCHA if needed
    await page.waitForTimeout(5000); // Wait for potential CAPTCHA challenge
    const captchaElement = await page.$('img[src*="captcha"]');
    if (captchaElement) {
      console.log('CAPTCHA detected');
      const captchaScreenshot = await captchaElement.screenshot({ encoding: 'base64' });
      const captchaSolution = await handleCaptcha(captchaScreenshot);
      await page.type('#captchacharacters', captchaSolution);
      await page.click('#captchachallenge-submit');
    }

    console.log('Successfully logged in with 2FA and CAPTCHA handling!');
  } catch (error) {
    console.error('Login failed:', error);
    sendNotification('Login Error', `Login failed: ${error.message}`);
    throw error;
  }
}

// Function to check for free items on Amazon
async function checkFreeItems(page) {
  try {
    await page.goto('https://www.amazon.com/s?k=free+items'); // Adjust URL for free item searches
    await page.waitForSelector('.s-search-results');

    const freeItems = await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('.s-result-item');

      elements.forEach((el) => {
        const priceText = el.querySelector('.a-price-whole')?.innerText || '';
        const price = parseFloat(priceText.replace(',', '')) || 0;

        if (price === 0) {
          const title = el.querySelector('h2')?.innerText || 'No title';
          const link = el.querySelector('a')?.href || '#';
          items.push({ title, link });
        }
      });

      return items;
    });

    return freeItems;
  } catch (error) {
    console.error('Error checking items:', error);
    throw error;
  }
}

// Function to purchase free items
async function purchaseItem(page, item) {
  try {
    await page.goto(item.link);
    await page.waitForSelector('#buy-now-button');
    await page.click('#buy-now-button');
    console.log(`Purchased: ${item.title}`);
    sendNotification('Purchase Successful', `Successfully purchased ${item.title}`);
  } catch (error) {
    console.error(`Failed to purchase ${item.title}:`, error);
    sendNotification('Purchase Error', `Error purchasing ${item.title}: ${error.message}`);
  }
}

// Main bot function
(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage();

  // Log into Amazon
  await loginWith2FA(page);

  // Continuously monitor for free items
  while (true) {
    try {
      const freeItems = await checkFreeItems(page);

      if (freeItems.length > 0) {
        console.log('Free items found:', freeItems);
        sendNotification('Free Items Found', JSON.stringify(freeItems));

        // Purchase the free items (up to 10 units)
        for (let i = 0; i < freeItems.length && i < 10; i++) {
          await purchaseItem(page, freeItems[i]);
          await delay(5000); // Short delay between purchases
        }
      }
    } catch (error) {
      console.error('Error during monitoring:', error);
      sendNotification('Monitoring Error', `Error: ${error.message}`);
    }

    // Wait 60 seconds before checking again
    await delay(60000);
  }

  await browser.close();
})();
