const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function checkAndUpdateAdminPassword() {
  try {
    const email = 'federico.dipierro87@gmail.com';
    const correctPassword = 'Attila11_2026!';

    console.log('Finding admin user...');

    const admin = await prisma.dJ.findUnique({
      where: { email }
    });

    if (!admin) {
      console.log('Admin user not found!');
      return;
    }

    console.log('Current admin data:');
    console.log('Email:', admin.email);
    console.log('Name:', admin.name);
    console.log('Is Admin:', admin.isAdmin);
    console.log('Status:', admin.status);

    // Test current password
    console.log('Testing current password...');
    const isCurrentPasswordValid = await bcrypt.compare(correctPassword, admin.password);
    
    if (isCurrentPasswordValid) {
      console.log('✅ Password is correct! Login should work.');
      return;
    }

    console.log('❌ Password is incorrect. Updating password...');

    // Hash the correct password
    const hashedPassword = await bcrypt.hash(correctPassword, 10);

    // Update admin user with correct password
    const updatedAdmin = await prisma.dJ.update({
      where: { email },
      data: {
        password: hashedPassword
      }
    });

    console.log('✅ Password updated successfully!');
    
    // Verify the update worked
    const finalCheck = await bcrypt.compare(correctPassword, updatedAdmin.password);
    console.log('Password verification:', finalCheck ? '✅ PASS' : '❌ FAIL');

  } catch (error) {
    console.error('Error checking/updating admin password:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAndUpdateAdminPassword();