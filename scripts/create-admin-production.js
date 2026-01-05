const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function createAdmin() {
  try {
    const email = 'federico.dipierro87@gmail.com';
    const password = 'Attila11_2026!';
    const name = 'Federico Di Pierro';

    console.log('Checking if admin already exists...');

    // Check if admin already exists
    const existingAdmin = await prisma.dJ.findUnique({
      where: { email }
    });

    if (existingAdmin) {
      console.log('Admin already exists!');
      console.log('Email:', existingAdmin.email);
      console.log('Name:', existingAdmin.name);
      console.log('Is Admin:', existingAdmin.isAdmin);
      console.log('Status:', existingAdmin.status);
      return;
    }

    console.log('Creating new admin user...');

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate unique event code for admin
    const generateEventCode = () => {
      return Math.random().toString(36).substring(2, 8).toUpperCase();
    };

    let eventCode;
    let isUnique = false;
    
    while (!isUnique) {
      eventCode = generateEventCode();
      const existing = await prisma.dJ.findUnique({
        where: { eventCode }
      });
      if (!existing) isUnique = true;
    }

    // Create admin user
    const admin = await prisma.dJ.create({
      data: {
        email,
        password: hashedPassword,
        name,
        eventCode: eventCode,
        status: 'APPROVED',
        isAdmin: true,
        minDonation: 5.00
      }
    });

    console.log('Admin created successfully!');
    console.log('Email:', admin.email);
    console.log('Name:', admin.name);
    console.log('Event Code:', admin.eventCode);
    console.log('Admin:', admin.isAdmin);
    console.log('Status:', admin.status);

  } catch (error) {
    console.error('Error creating admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();