const dotenv = require('dotenv');
dotenv.config();

const { EmailService } = require('../dist/services/email.service');

async function testEmails() {
  console.log('Testing email service...');
  
  // Test approval email
  console.log('\n1. Testing DJ approval email...');
  const approvalResult = await EmailService.sendDJApprovalEmail(
    'test@example.com', 
    'DJ Test'
  );
  console.log('Approval email result:', approvalResult ? 'SUCCESS' : 'FAILED');
  
  // Test rejection email
  console.log('\n2. Testing DJ rejection email...');
  const rejectionResult = await EmailService.sendDJRejectionEmail(
    'test@example.com', 
    'DJ Test'
  );
  console.log('Rejection email result:', rejectionResult ? 'SUCCESS' : 'FAILED');
}

testEmails().catch(console.error);