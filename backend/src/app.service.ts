// Briefcase/backend/src/app.service.ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Welcome to Briefcase API - Media Library Manager';
  }
}