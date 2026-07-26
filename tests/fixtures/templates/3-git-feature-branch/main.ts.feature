export class AuthService {
  private attempts = 0;

  public authenticate(token: string): boolean {
    this.attempts++;
    return token === 'secret';
  }

  public reset(): void {
    this.attempts = 0;
  }
}

export function main() {
  const service = new AuthService();
  service.authenticate('token');
}
