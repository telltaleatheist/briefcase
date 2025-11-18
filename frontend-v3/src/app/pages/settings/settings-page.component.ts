import { Component, signal, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AiSetupWizardComponent } from '../../components/ai-setup-wizard/ai-setup-wizard.component';
import { AiSetupService } from '../../services/ai-setup.service';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule, AiSetupWizardComponent],
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPageComponent implements OnInit {
  private aiSetupService = inject(AiSetupService);

  // AI Setup Wizard state
  wizardOpen = signal(false);

  // AI status
  aiConfigured = signal(false);
  activeProviders = signal<string[]>([]);

  async ngOnInit() {
    await this.refreshAiStatus();
  }

  private async refreshAiStatus() {
    await this.aiSetupService.checkAIAvailability();
    const status = this.aiSetupService.getSetupStatus();

    this.aiConfigured.set(status.isReady);
    this.activeProviders.set(status.availableProviders.map(p => {
      switch (p) {
        case 'ollama': return 'Ollama';
        case 'claude': return 'Claude';
        case 'openai': return 'OpenAI';
        default: return p;
      }
    }));
  }

  openAiWizard() {
    this.wizardOpen.set(true);
  }

  closeAiWizard() {
    this.wizardOpen.set(false);
  }

  async onWizardCompleted() {
    this.wizardOpen.set(false);
    await this.refreshAiStatus();
  }
}
