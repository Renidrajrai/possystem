import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  TZ_OFFSET_MINUTES: z.coerce.number().int().default(345), // Asia/Kathmandu = UTC+05:45
  TIMEZONE: z.string().default('Asia/Kathmandu'),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).default('977'),
  MEMBERSHIP_PREFIX: z.string().min(1).max(10).default('CAFE'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message instead of crashing later.
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
