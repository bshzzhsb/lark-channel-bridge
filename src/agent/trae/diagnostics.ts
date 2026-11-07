/** Headless runs must guide the user back to terminal login, never launch it. */
export function withTraeLoginHint(message: string): string {
  if (message.includes('traecli login')) return message;
  if (/not authenticated|not logged in|sign in|log in|login|auth token|authenticate|authentication.*(?:fail|error)|code[=: ]+1001/i.test(message)) {
    return `${message}\n请先在终端运行 traecli login，完成登录后重试。`;
  }
  return message;
}
