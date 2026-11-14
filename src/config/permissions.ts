/**
 * Permission codes. Seeded into the `permissions` table and mapped to roles below.
 * Enforced on the backend by `requirePermission(...)`.
 */
export const PERMISSIONS = {
  // staff & settings
  USER_MANAGE: 'user.manage',
  ROLE_VIEW: 'role.view',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',
  // customers
  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_MANAGE: 'customer.manage',
  // menu
  MENU_VIEW: 'menu.view',
  MENU_MANAGE: 'menu.manage',
  MENU_AVAILABILITY: 'menu.availability',
  // tables
  TABLE_VIEW: 'table.view',
  TABLE_MANAGE: 'table.manage',
  // orders
  ORDER_CREATE: 'order.create',
  ORDER_VIEW: 'order.view',
  ORDER_VIEW_ALL: 'order.viewAll', // see orders created by other staff
  ORDER_UPDATE: 'order.update',
  ORDER_CANCEL: 'order.cancel',
  // kitchen
  KITCHEN_VIEW: 'kitchen.view',
  KITCHEN_UPDATE: 'kitchen.update',
  // billing
  BILL_CHECKOUT: 'bill.checkout',
  BILL_VOID: 'bill.void',
  BILL_ADJUST: 'bill.adjust',
  PAYMENT_CREATE: 'payment.create',
  PAYMENT_REFUND: 'payment.refund',
  DISCOUNT_APPLY: 'discount.apply', // up to the configured cashier limit
  DISCOUNT_OVERRIDE: 'discount.override', // above the limit
  // shifts
  SHIFT_MANAGE: 'shift.manage', // open/close own shift, cash movements
  SHIFT_VIEW_ALL: 'shift.viewAll',
  // reports
  REPORT_VIEW: 'report.view',
  // inventory & purchasing
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_MANAGE: 'inventory.manage',
  SUPPLIER_MANAGE: 'supplier.manage',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  'user.manage': 'Create and manage staff accounts',
  'role.view': 'View roles and permissions',
  'settings.manage': 'Edit business, tax, payment-method and station settings',
  'audit.view': 'View the audit log',
  'customer.view': 'Look up customers and members',
  'customer.manage': 'Create and edit customers',
  'menu.view': 'View the menu',
  'menu.manage': 'Create and edit menu items, prices, variants and modifiers',
  'menu.availability': 'Toggle menu item availability',
  'table.view': 'View floors and tables',
  'table.manage': 'Create and edit floors and tables',
  'order.create': 'Create orders',
  'order.view': 'View own orders',
  'order.viewAll': 'View all orders',
  'order.update': 'Add and change items on open orders, move and merge tables',
  'order.cancel': 'Cancel orders and order items',
  'kitchen.view': 'View kitchen tickets',
  'kitchen.update': 'Update kitchen ticket status',
  'bill.checkout': 'Checkout orders and issue bills',
  'bill.void': 'Void unpaid bills',
  'bill.adjust': 'Issue credit/debit notes',
  'payment.create': 'Record payments',
  'payment.refund': 'Refund payments',
  'discount.apply': 'Apply discounts up to the cashier limit',
  'discount.override': 'Apply discounts above the cashier limit',
  'shift.manage': 'Open/close own shift and record cash movements',
  'shift.viewAll': 'View every staff member’s shifts',
  'report.view': 'View reports',
  'inventory.view': 'View inventory',
  'inventory.manage': 'Manage inventory, recipes and stock adjustments',
  'supplier.manage': 'Manage suppliers and purchase orders',
};

const P = PERMISSIONS;
const all = Object.values(PERMISSIONS) as PermissionCode[];

export const ROLE_PERMISSIONS: Record<string, PermissionCode[]> = {
  OWNER: all,
  MANAGER: all.filter((p) => p !== P.USER_MANAGE && p !== P.SETTINGS_MANAGE),
  CASHIER: [
    P.CUSTOMER_VIEW,
    P.CUSTOMER_MANAGE,
    P.MENU_VIEW,
    P.TABLE_VIEW,
    P.ORDER_CREATE,
    P.ORDER_VIEW,
    P.ORDER_VIEW_ALL, // counter staff share open tabs across shifts
    P.ORDER_UPDATE,
    P.KITCHEN_VIEW,
    P.BILL_CHECKOUT,
    P.PAYMENT_CREATE,
    P.DISCOUNT_APPLY,
    P.SHIFT_MANAGE,
  ],
  KITCHEN: [P.KITCHEN_VIEW, P.KITCHEN_UPDATE, P.MENU_VIEW],
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: 'Owner / Admin – everything',
  MANAGER: 'Manager – daily operations, stock, reports, refunds',
  CASHIER: 'Cashier – orders, checkout, receipts',
  KITCHEN: 'Kitchen staff – tickets only, no payment access',
};
