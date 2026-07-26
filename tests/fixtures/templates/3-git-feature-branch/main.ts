export class AuthService {
  private attempts = 0;

  public getAttempts(): number {
    return this.attempts;
  }

  public authenticate(token: string): boolean {
    this.attempts++;
    return token === 'secret';
  }
}

export function main() {
  const service = new AuthService();
  service.authenticate('token');
}
