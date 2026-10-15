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

export const ALLOWED_SYNC_SETTINGS = ['farm_name', 'admin_name', 'admin_phone', 'default_milk_rate'] as const;

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
