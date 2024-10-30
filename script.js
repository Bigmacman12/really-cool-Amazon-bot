const dotenv = require('dotenv');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

// Load environment variables
const result = dotenv.config();
if (result.error) {
    throw new Error("Failed to load .env file");
}
console.log('Environment variables loaded:', process.env);

// Check for required environment variables
const requiredEnvVars = [
    'SENDGRID_API_KEY',
    'EMAIL_USER',
    'EMAIL_RECEIVER',
    'AMAZON_EMAIL',
    'AMAZON_PASSWORD'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missingVars.join(', ')}`);
}

// Nodemailer using SendGrid
const transporter = nodemailer.createTransport({
    service: 'SendGrid',
    auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY,
    },
});

// Function to send notifications via email
async function sendNotification(subject, message) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_RECEIVER,
            subject: subject,
            text: message,
        });
        console.log('Notification sent:', subject);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
}

// Updated Amazon login URL
const LOGIN_URL = 'https://www.amazon.com/ap/signin?...'; // shortened for brevity

// Random delay function
const randomDelay = (min = 1000, max = 3000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

// Typing simulation
const typeWithDelay = async (page, selector, text) => {
    await page.waitForSelector(selector);
    for (const char of text) {
        await page.type(selector, char, { delay: Math.random() * 100 + 50 }); // Random delay between 50 to 150 ms
    }
};

// Object to track purchase counts for each item
const purchaseCounts = {};

// Login to Amazon
async function loginWithSms2FA(page) {
    try {
        const response = await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        console.log('Login Page Response Status:', response.status());

        if (response.status() !== 200) {
            throw new Error(`Failed to navigate to login page. Status: ${response.status()}`);
        }

        await typeWithDelay(page, '#ap_email', process.env.AMAZON_EMAIL);
        await page.click('#continue');
        await typeWithDelay(page, '#ap_password', process.env.AMAZON_PASSWORD);
        
        await Promise.all([
            page.click('#signInSubmit'),
            page.waitForNavigation({ waitUntil: 'networkidle0' })
        ]);

        console.log('Login successful!');
    } catch (error) {
        console.error('Login failed:', error);
        await sendNotification('Login Error', `Login failed: ${error.message}`);
        throw error;
    }
}

// Function to check for items priced at $0
async function checkForItemsAtZero(page) {
    try {
        await page.goto('https://www.amazon.com/s?k=free+items', { waitUntil: 'networkidle2' });

        const items = await page.$$eval('.s-main-slot .s-result-item', items => {
            return items.map(item => {
                const priceText = item.querySelector('.a-price .a-offscreen')?.innerText;
                const freeShipping = item.querySelector('.a-color-price')?.innerText.includes('Free Shipping');
                const itemTitle = item.querySelector('h2 a span')?.innerText;
                const asin = item.getAttribute('data-asin');
                return { title: itemTitle, price: priceText, freeShipping, asin };
            }).filter(item => item.price === '$0' && item.freeShipping);
        });

        if (items.length > 0) {
            await sendNotification('Free Items Found', `Found free items: ${JSON.stringify(items)}`);

            // Implement purchasing logic here
            for (const item of items) {
                if (item.price === '$0' && item.freeShipping) {
                    const currentCount = purchaseCounts[item.asin] || 0;
                    if (currentCount < 15) { // Limit to 15 purchases per item
                        console.log(`Purchasing item: ${item.title} (ASIN: ${item.asin})`);
                        await purchaseItem(page, item.asin);
                        purchaseCounts[item.asin] = currentCount + 1; // Increment purchase count
                    } else {
                        console.log(`Maximum purchase limit reached for item: ${item.title} (ASIN: ${item.asin})`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error checking for items at zero:', error);
        await sendNotification('Check Error', `Error checking for items: ${error.message}`);
    }
}

// Function to purchase an item
async function purchaseItem(page, asin) {
    try {
        // Navigate to the item's page using the ASIN
        await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'networkidle2' });

        // Click the "Add to Cart" button
        await page.waitForSelector('#add-to-cart-button', { timeout: 5000 });
        await page.click('#add-to-cart-button');
        console.log(`Added item ${asin} to cart.`);

        // Proceed to checkout
        await page.waitForSelector('#nav-cart', { timeout: 5000 });
        await page.click('#nav-cart');
        await page.waitForSelector('.sc-buy-box-pt', { timeout: 5000 }); // Wait for the purchase button
        await page.click('.sc-buy-box-pt'); // Click the purchase button

        console.log(`Purchased item with ASIN: ${asin}`);
        await sendNotification('Purchase Successful', `Purchased item with ASIN: ${asin}`);
    } catch (error) {
        console.error('Error purchasing item:', error);
        await sendNotification('Purchase Error', `Error purchasing item with ASIN: ${asin}: ${error.message}`);
    }
}

// Main function
(async () => {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    try {
        await loginWithSms2FA(page); // Log into Amazon and handle 2FA
        
        // Run for 24 hours
        const endTime = Date.now() + 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        while (Date.now() < endTime) {
            try {
                await checkForItemsAtZero(page); // Check for items reaching $0

                // Wait for a specified time before checking again (e.g., 2-3 minutes)
                await randomDelay(2 * 60 * 1000); // Check every 2 minutes
            } catch (checkError) {
                console.error('Error checking items:', checkError);
            }
        }

    } catch (error) {
        console.error('Main function error:', error);
    } finally {
        await browser.close();
    }
})();
