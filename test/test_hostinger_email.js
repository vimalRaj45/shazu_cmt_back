/**
 * Standalone Hostinger Email API Test Script
 * Usage: node test/test_hostinger_email.js [recipient_email]
 */

require('dotenv').config();

let Configuration, AccountApi, SendApi;
let sdkLoaded = false;
try {
  const sdk = require('hostinger-mail-api-sdk');
  Configuration = sdk.Configuration;
  AccountApi = sdk.AccountApi;
  SendApi = sdk.SendApi;
  sdkLoaded = true;
} catch (_) {
  sdkLoaded = false;
}

const HOSTINGER_API_KEY = process.env.HOSTINGER_API_KEY;
const SENDER_EMAIL = process.env.HOSTINGER_SENDER_EMAIL || 'info@shazusofttechnologies.org';
const SENDER_NAME = process.env.HOSTINGER_SENDER_NAME || 'Shazu Soft Technologies';
const targetEmail = process.argv[2] || 'vimalraj5207@gmail.com';

async function runTest() {
  console.log('\n--- Hostinger Mail SDK Test ---');
  console.log(`[Config] Sender Name     : ${SENDER_NAME}`);
  console.log(`[Config] Sender Email    : ${SENDER_EMAIL}`);
  console.log(`[Config] Target Recipient: ${targetEmail}`);
  console.log(`[Config] SDK Loaded      : ${sdkLoaded ? 'YES' : 'NO'}`);
  console.log(`[Config] API Key Present : ${HOSTINGER_API_KEY ? 'YES (' + HOSTINGER_API_KEY.slice(0, 12) + '...)' : 'NO'}`);

  if (!HOSTINGER_API_KEY) {
    console.error('\n❌ ERROR: HOSTINGER_API_KEY missing in backend/.env\n');
    return;
  }

  if (!sdkLoaded) {
    console.error('\n❌ ERROR: hostinger-mail-api-sdk module is not installed yet.');
    console.error('Please run: npm install hostinger-mail-api-sdk\n');
    return;
  }

  const config = new Configuration({
    accessToken: HOSTINGER_API_KEY,
    apiKey: HOSTINGER_API_KEY,
  });

  const accountApi = new AccountApi(config);
  const sendApi = new SendApi(config);

  let mailboxResourceId = null;

  try {
    const acc = await accountApi.getCurrentAccount();
    const accData = acc.data ? acc.data.data || acc.data : acc;
    const mailboxes = accData.mailboxes || (Array.isArray(accData) ? accData : []);
    
    console.log(`Found ${mailboxes.length} mailbox(es) in Hostinger Account:`);
    mailboxes.forEach((mb, idx) => {
      console.log(`  [${idx + 1}] Email: ${mb.email || mb.address || 'N/A'} | Resource ID: ${mb.resourceId || mb.id || 'N/A'}`);
    });

    const targetAddress = SENDER_EMAIL.toLowerCase().trim();
    const matchedMb = mailboxes.find(
      (mb) => (mb.email && mb.email.toLowerCase().trim() === targetAddress) || (mb.address && mb.address.toLowerCase().trim() === targetAddress)
    );

    if (matchedMb) {
      mailboxResourceId = matchedMb.resourceId || matchedMb.id;
      console.log(`\n🎯 Matched SENDER_EMAIL (${SENDER_EMAIL}) -> Resource ID: ${mailboxResourceId}`);
    } else if (mailboxes.length > 0) {
      mailboxResourceId = mailboxes[0].resourceId || mailboxes[0].id;
      console.log(`\n⚠️ SENDER_EMAIL (${SENDER_EMAIL}) not explicitly found in list. Using first available mailbox: ${mailboxResourceId}`);
    }
  } catch (err) {
    console.log(`Lookup note: ${err.message}`);
  }

  if (!mailboxResourceId) {
    mailboxResourceId = 'AC27733647b7b2b04cefeca882d854';
  }

  try {
    const sendRequest = {
      from: SENDER_NAME ? `${SENDER_NAME} <${SENDER_EMAIL}>` : SENDER_EMAIL,
      to: [targetEmail],
      subject: `🎉 Hostinger Email Test from ${SENDER_EMAIL}`,
      html: `<h3>Hostinger Mail API SDK is live and working!</h3><p>Sent from: <strong>${SENDER_EMAIL}</strong> (${SENDER_NAME})</p>`,
      text: `Sent from: ${SENDER_EMAIL} (${SENDER_NAME})`,
    };

    const res = await sendApi.sendEmail(mailboxResourceId, sendRequest);
    console.log(`\n✅ SUCCESS! Email sent from ${SENDER_EMAIL} to ${targetEmail}. HTTP Status: ${res ? res.status || 204 : 204}\n`);
  } catch (err) {
    console.error('\n❌ ERROR:', err.response ? JSON.stringify(err.response.data) : err.message, '\n');
  }
}

runTest();
