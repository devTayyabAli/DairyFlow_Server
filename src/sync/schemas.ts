import { z } from 'zod';

export const buyerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  is_default: z.union([z.literal(0), z.literal(1)]).default(0),
  created_at: z.string(),
});

export const milkEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  shift: z.enum(['Morning', 'Evening']),
  liters: z.number().positive('Liters must be positive'),
  fat_percentage: z.number().min(0, 'Fat percentage cannot be negative'),
  rate_per_liter: z.number().min(0, 'Rate per liter cannot be negative'),
  total_amount: z.number().min(0, 'Total amount cannot be negative'),
  buyer_uuid: z.string().min(1, 'Buyer UUID is required'),
  buyer_name: z.string().min(1, 'Buyer name is required'),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const expenseCategoryEnum = z.enum([
  'Feed',
  'Labour',
  'Veterinary',
  'Transport',
  'Utilities',
  'Maintenance',
  'Other',
]);

export const expenseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  category: expenseCategoryEnum,
  title: z.string().min(1, 'Expense title is required'),
  amount: z.number().positive('Amount must be positive'),
  quantity: z.number().positive().nullable().optional(),
  unit: z.string().nullable().optional(),
  unit_price: z.number().positive().nullable().optional(),
  supplier_or_payee: z.string().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const buyerPaymentSchema = z.object({
  buyer_uuid: z.string().min(1, 'Buyer UUID is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  amount: z.number().positive('Payment amount must be positive'),
  payment_method: z.string().default('Cash'),
  received_by: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const animalSpeciesEnum = z.enum(['Cow', 'Buffalo', 'Calf']);
export const animalGenderEnum = z.enum(['Female', 'Male']);
export const animalStatusEnum = z.enum(['Lactating', 'Dry', 'Pregnant', 'Heifer', 'Bull', 'Calf']);

export const livestockSchema = z.object({
  tag_number: z.string().min(1, 'Tag number is required'),
  name: z.string().nullable().optional(),
  species: animalSpeciesEnum,
  gender: animalGenderEnum,
  status: animalStatusEnum,
  breed: z.string().nullable().optional(),
  birth_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const activityTypeEnum = z.enum([
  'Vaccination',
  'Deworming',
  'Calving',
  'Insemination',
  'Treatment',
  'Group Move',
  'Other',
]);

export const livestockActivitySchema = z.object({
  animal_uuid: z.string().nullable().optional(),
  animal_tag: z.string().min(1, 'Animal tag is required'),
  activity_type: activityTypeEnum,
  title: z.string().min(1, 'Activity title is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

// ==========================================
// DODHI PORTAL & FINANCIAL LEDGER SCHEMAS
// ==========================================
export const supplierRateTypeEnum = z.enum(['flat', 'fat_based']);
export const supplierStatusEnum = z.enum(['active', 'inactive']);

export const supplierSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().nullable().optional(),
  village: z.string().nullable().optional(),
  rate_type: supplierRateTypeEnum.default('fat_based'),
  flat_rate: z.number().min(0).nullable().optional(),
  base_fat: z.number().min(0).nullable().optional(),
  rate_per_fat_point: z.number().min(0).nullable().optional(),
  balance: z.number().default(0),
  status: supplierStatusEnum.default('active'),
  linked_farm_id: z.string().nullable().optional(),
  created_at: z.string(),
});

export const milkCollectionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  shift: z.enum(['Morning', 'Evening']),
  supplier_uuid: z.string().min(1, 'Supplier UUID is required'),
  supplier_name: z.string().min(1, 'Supplier name is required'),
  collector_id: z.string().nullable().optional(),
  collector_name: z.string().nullable().optional(),
  liters: z.number().positive('Liters must be positive'),
  fat_percentage: z.number().min(0, 'Fat percentage cannot be negative'),
  rate_per_liter: z.number().min(0, 'Rate per liter cannot be negative'),
  total_amount: z.number().min(0, 'Total amount cannot be negative'),
  pricing_band_uuid: z.string().nullable().optional(),
  collected_at: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const targetTypeEnum = z.enum(['buyer', 'supplier']);
export const repaymentTermsEnum = z.enum(['single_cut', 'weekly_cut', 'manual']);
export const advanceStatusEnum = z.enum(['active', 'repaid', 'cancelled']);

export const advanceSchema = z.object({
  target_type: targetTypeEnum,
  target_uuid: z.string().min(1, 'Target UUID is required'),
  target_name: z.string().min(1, 'Target name is required'),
  amount: z.number().positive('Amount must be positive'),
  remaining_balance: z.number().min(0, 'Remaining balance cannot be negative'),
  repayment_terms: repaymentTermsEnum.default('weekly_cut'),
  deduction_per_settlement: z.number().min(0).default(0),
  status: advanceStatusEnum.default('active'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const settlementStatusEnum = z.enum(['draft', 'due', 'paid', 'overdue', 'disputed']);

export const settlementSchema = z.object({
  target_type: targetTypeEnum,
  target_uuid: z.string().min(1, 'Target UUID is required'),
  target_name: z.string().min(1, 'Target name is required'),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be YYYY-MM-DD'),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be YYYY-MM-DD'),
  gross_amount: z.number().min(0, 'Gross amount cannot be negative'),
  advance_deduction: z.number().min(0).default(0),
  net_amount: z.number(),
  status: settlementStatusEnum.default('due'),
  expected_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date must be YYYY-MM-DD'),
  actual_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  payment_method: z.string().default('Cash'),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});

export const ledgerEntryTypeEnum = z.enum([
  'milk_sale',
  'milk_collection',
  'advance_given',
  'advance_deduction',
  'payment_received',
  'settlement_payout',
  'adjustment',
]);

export const ledgerEntrySchema = z.object({
  account_type: targetTypeEnum,
  account_uuid: z.string().min(1, 'Account UUID is required'),
  account_name: z.string().min(1, 'Account name is required'),
  entry_type: ledgerEntryTypeEnum,
  amount: z.number(),
  reference_id: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  notes: z.string().nullable().optional(),
  payment_method: z.string().max(40).nullable().optional(),
  payment_reference: z.string().max(80).nullable().optional(),
  created_at: z.string(),
});

export const fatRateBandSchema = z
  .object({
    min_fat: z.number().min(0).max(100),
    max_fat: z.number().min(0).max(100),
    rate_per_liter: z.number().positive('Rate per liter must be positive'),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    active: z.number().int().min(0).max(1).default(1),
    label: z.string().max(80).nullable().optional(),
    created_at: z.string(),
  })
  .refine((band) => band.min_fat <= band.max_fat, { message: 'min_fat cannot be above max_fat' })
  .refine((band) => !band.effective_to || band.effective_from <= band.effective_to, {
    message: 'effective_from cannot be after effective_to',
  });

export const collectorAssignmentSchema = z.object({
  collector_user_id: z.string().min(1),
  supplier_uuid: z.string().min(1),
  active: z.number().int().min(0).max(1).default(1),
  created_at: z.string(),
});

// Keep in sync with SYNCED_SETTING_KEYS in mobile/src/db/database.ts.
export const ALLOWED_SYNC_SETTINGS = [
  'farm_name',
  'admin_name',
  'admin_phone',
  'default_milk_rate',
  'fat_pricing_enabled',
  'fat_pricing_reference_fat',
  'fat_pricing_slope',
] as const;

export const settingsSchema = z.object({
  value: z.string(),
});

export const tableSchemas: Record<string, z.ZodTypeAny> = {
  buyers: buyerSchema,
  milk_entries: milkEntrySchema,
  expenses: expenseSchema,
  buyer_payments: buyerPaymentSchema,
  livestock: livestockSchema,
  livestock_activities: livestockActivitySchema,
  suppliers: supplierSchema,
  milk_collections: milkCollectionSchema,
  advances: advanceSchema,
  settlements: settlementSchema,
  ledger_entries: ledgerEntrySchema,
  fat_rate_bands: fatRateBandSchema,
  collector_assignments: collectorAssignmentSchema,
  settings: settingsSchema,
};

export const changeSchema = z.object({
  table: z.enum([
    'buyers',
    'milk_entries',
    'expenses',
    'buyer_payments',
    'livestock',
    'livestock_activities',
    'suppliers',
    'milk_collections',
    'advances',
    'settlements',
    'ledger_entries',
    'fat_rate_bands',
    'collector_assignments',
    'settings',
  ]),
  uuid: z.string().min(1, 'UUID is required'),
  op: z.enum(['upsert', 'delete']),
  data: z.record(z.string(), z.unknown()).optional(),
  clientUpdatedAt: z.string().min(1, 'clientUpdatedAt is required'),
});

export type Change = z.infer<typeof changeSchema>;

export interface ServerChange {
  table: string;
  uuid: string;
  op: 'upsert' | 'delete';
  data?: Record<string, unknown>;
  seq: number;
}
