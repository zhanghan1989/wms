export const STRONG_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{12,64}$/;

export function isStrongPassword(value: unknown): boolean {
  return STRONG_PASSWORD_PATTERN.test(String(value ?? ''));
}

export const STRONG_PASSWORD_MESSAGE =
  '密码必须为12到64位，并同时包含大写字母、小写字母、数字和特殊字符，且不能包含空格';
