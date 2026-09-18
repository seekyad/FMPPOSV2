import crypto from 'node:crypto';

const developmentSecret = crypto.randomBytes(48).toString('hex');
export const isProduction = () => Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';

export function sessionSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (isProduction() && (!configured || configured.length < 32 || configured === 'dev-secret-change-in-render-env')) {
    throw new Error('Production requires a unique JWT_SECRET of at least 32 characters');
  }
  return configured || developmentSecret;
}

export function validateProductionConfig() {
  sessionSecret();
  if (isProduction() && !process.env.DATABASE_URL) throw new Error('Production requires DATABASE_URL');
}
