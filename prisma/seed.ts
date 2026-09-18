import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const adminName = process.env.SEED_ADMIN_NAME || 'Admin User';

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    create: { name: adminName, email: adminEmail, passwordHash, role: 'ADMIN' },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: 'sales@example.com' },
    create: {
      name: 'Sales Rep',
      email: 'sales@example.com',
      passwordHash: await bcrypt.hash('ChangeMe123!', 10),
      role: 'SALES',
    },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: 'ops@example.com' },
    create: {
      name: 'Operations',
      email: 'ops@example.com',
      passwordHash: await bcrypt.hash('ChangeMe123!', 10),
      role: 'OPERATIONS',
    },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: 'accounting@example.com' },
    create: {
      name: 'Accounting',
      email: 'accounting@example.com',
      passwordHash: await bcrypt.hash('ChangeMe123!', 10),
      role: 'ACCOUNTING',
    },
    update: {},
  });

  const warehouse = await prisma.warehouse.upsert({
    where: { id: 'seed-main-warehouse' },
    create: { id: 'seed-main-warehouse', name: 'Main Warehouse', isDefault: true },
    update: {},
  });

  const company = await prisma.company.upsert({
    where: { id: 'seed-acme' },
    create: {
      id: 'seed-acme',
      name: 'Acme Corp',
      type: 'CUSTOMER',
      taxId: 'US-000-1234',
      website: 'https://acme.example.com',
      city: 'Austin',
      country: 'USA',
      ownerId: admin.id,
      emails: { create: [{ label: 'main', address: 'billing@acme.example.com' }] },
      phones: { create: [{ label: 'main', number: '+1-555-0100' }] },
    },
    update: {},
  });

  const contact = await prisma.contact.upsert({
    where: { id: 'seed-jane' },
    create: {
      id: 'seed-jane',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@acme.example.com',
      phone: '+1-555-0101',
      companyId: company.id,
      position: 'Purchasing Manager',
    },
    update: {},
  });

  const product = await prisma.product.upsert({
    where: { sku: 'WIDGET-001' },
    create: {
      sku: 'WIDGET-001',
      name: 'Standard Widget',
      description: 'A standard widget for demo purposes.',
      price: 49.99,
      cost: 20,
      taxRate: 8,
      reorderPoint: 10,
    },
    update: {},
  });

  const variant = await prisma.productVariant.upsert({
    where: { sku: 'WIDGET-001-DEFAULT' },
    create: { productId: product.id, sku: 'WIDGET-001-DEFAULT', name: 'Default' },
    update: {},
  });

  await prisma.stockLevel.upsert({
    where: { productVariantId_warehouseId: { productVariantId: variant.id, warehouseId: warehouse.id } },
    create: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 100 },
    update: {},
  });

  await prisma.opportunity.upsert({
    where: { id: 'seed-opp-1' },
    create: {
      id: 'seed-opp-1',
      title: 'Acme Corp - Q1 widget order',
      companyId: company.id,
      contactId: contact.id,
      stage: 'PROPOSAL',
      value: 5000,
      ownerId: admin.id,
    },
    update: {},
  });

  console.log('Seed complete.');
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
