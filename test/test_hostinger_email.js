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
const targetEmail = process.argv[2] || 'vimalraj5207@gmail.com';

async function runTest() {
  console.log('\n--- Hostinger Mail SDK Test ---');
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

  let mailboxResourceId = 'AC27733647b7b2b04cefeca882d854';

  try {
    const acc = await accountApi.getCurrentAccount();
    const accData = acc.data ? acc.data.data || acc.data : acc;
    if (accData && accData.mailboxes && accData.mailboxes.length > 0) {
      mailboxResourceId = accData.mailboxes[0].resourceId;
    }
  } catch (_) {}

  try {
    const sendRequest = {
      to: [targetEmail],
      subject: '🎉 Hostinger SDK Integration Test',
      html: '<h3>Hostinger Mail API SDK is live and working!</h3>',
      text: 'Hostinger Mail API SDK is live and working!',
    };

    const res = await sendApi.sendEmail(mailboxResourceId, sendRequest);
    console.log(`\n✅ SUCCESS! Email sent to ${targetEmail}. HTTP Status: ${res ? res.status || 204 : 204}\n`);
  } catch (err) {
    console.error('\n❌ ERROR:', err.response ? JSON.stringify(err.response.data) : err.message, '\n');
  }
}

runTest();
