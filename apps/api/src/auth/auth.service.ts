import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(username: string, password: string): Promise<{
    accessToken: string;
    user: Pick<User, 'id' | 'username' | 'role' | 'status'>;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        passwordHash: true,
      },
    });
    if (!user || user.status === 0) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatch = await compare(password, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id.toString(),
      username: user.username,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
      },
    };
  }

  async getMe(id: bigint): Promise<Pick<User, 'id' | 'username' | 'role' | 'status'>> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }
}
