import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
});

export const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(255),
  role: z.enum(['admin', 'user']).default('user'),
  accessExpiresAt: z.string().datetime().nullable().optional(),
});

export const updateUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  isActive: z.boolean().optional(),
  accessExpiresAt: z.string().datetime().nullable().optional(),
  password: z.string().min(12).max(255).optional(),
});

export const assessmentSchema = z.object({
  name: z.string().min(1).max(255),
  state: z.record(z.unknown()), // the app's state object — arbitrary JSON
});

export const updateAssessmentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  state: z.record(z.unknown()).optional(),
});
