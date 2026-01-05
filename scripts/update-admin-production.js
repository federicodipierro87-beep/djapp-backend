const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function updateAdmin() {
  try {
    const email = 'federico.dipierro87@gmail.com';

    console.log('Finding admin user...');

    const existingAdmin = await prisma.dJ.findUnique({
      where: { email }
    });

    if (!existingAdmin) {
      console.log('Admin user not found!');
      return;
    }

    console.log('Current admin status:');
    console.log('Email:', existingAdmin.email);
    console.log('Name:', existingAdmin.name);
    console.log('Is Admin:', existingAdmin.isAdmin);
    console.log('Status:', existingAdmin.status);

    console.log('Updating admin user...');

    // Update admin user
    const updatedAdmin = await prisma.dJ.update({
      where: { email },
      data: {
        isAdmin: true,
        status: 'APPROVED'
      }
    });

    console.log('Admin updated successfully!');
    console.log('Email:', updatedAdmin.email);
    console.log('Name:', updatedAdmin.name);
    console.log('Event Code:', updatedAdmin.eventCode);
    console.log('Is Admin:', updatedAdmin.isAdmin);
    console.log('Status:', updatedAdmin.status);

  } catch (error) {
    console.error('Error updating admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateAdmin();