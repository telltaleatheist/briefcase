// Briefcase/backend/src/app.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LibraryManagerService } from './database/library-manager.service';

describe('AppController', () => {
  let appController: AppController;
  const libraryManager = {
    getActiveLibrary: jest.fn(),
    isDatabaseReady: jest.fn(),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: LibraryManagerService, useValue: libraryManager }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health check', () => {
    it('reports the active library once its database is ready', () => {
      libraryManager.getActiveLibrary.mockReturnValue({ name: 'Studio' });
      libraryManager.isDatabaseReady.mockReturnValue(true);
      expect(appController.getHealth()).toEqual({
        status: 'ok',
        message: 'Briefcase backend is running',
        libraryReady: true,
        activeLibrary: 'Studio',
      });
    });

    it('is still ok with no library (the volume may mount late)', () => {
      libraryManager.getActiveLibrary.mockReturnValue(null);
      libraryManager.isDatabaseReady.mockReturnValue(false);
      expect(appController.getHealth()).toMatchObject({ status: 'ok', libraryReady: false, activeLibrary: null });
    });
  });
});
