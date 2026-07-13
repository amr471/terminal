import { z } from 'zod';

export const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(256),
  locale: z.enum(['en', 'ru']).optional(),
  displayName: z.string().min(1).max(100).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const googleCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const discordCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

/** Shape posted by the Telegram Login Widget's JS callback (data-onauth). */
export const telegramLoginSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
});

/**
 * Same payload shape, but as Telegram's oauth.telegram.org redirect-link
 * method delivers it — GET query-string params (P1.2c), always strings on
 * the wire, so id/auth_date need coercion back to numbers before this
 * matches TelegramLoginPayload.
 */
export const telegramCallbackQuerySchema = z.object({
  id: z.coerce.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.coerce.number(),
  hash: z.string(),
});
