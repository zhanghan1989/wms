export function getJwtSecret(): string {
  const secret = String(process.env.JWT_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('JWT_SECRET must be configured');
  }
  return secret;
}
