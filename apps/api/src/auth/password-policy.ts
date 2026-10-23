export const PASSWORD_PATTERN = /^\S{6,64}$/;

export function isValidPassword(value: unknown): boolean {
  return PASSWORD_PATTERN.test(String(value ?? ''));
}

export const PASSWORD_MESSAGE =
  '密码必须为6到64位，且不能包含空格';
