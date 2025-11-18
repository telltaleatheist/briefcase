import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardComponent } from '../../components/card/card.component';
import { ButtonComponent } from '../../components/button/button.component';

@Component({
  selector: 'app-components',
  standalone: true,
  imports: [CommonModule, CardComponent, ButtonComponent],
  templateUrl: './components.component.html',
  styleUrls: ['./components.component.scss']
})
export class ComponentsComponent {
  buttonVariants = ['primary', 'secondary', 'outline', 'ghost', 'gradient'] as const;
  buttonSizes = ['sm', 'md', 'lg'] as const;

  badges = [
    { text: 'Default', class: '' },
    { text: 'Success', class: 'badge-success' },
    { text: 'Warning', class: 'badge-warning' },
    { text: 'Error', class: 'badge-error' },
    { text: 'Info', class: 'badge-info' }
  ];

  sampleCards = [
    {
      icon: '🚀',
      title: 'Getting Started',
      badge: 'New',
      badgeClass: 'badge-success',
      content: 'Quick start guide to building with Creamsicle components.'
    },
    {
      icon: '📚',
      title: 'Documentation',
      badge: 'Updated',
      badgeClass: 'badge-info',
      content: 'Comprehensive docs for all components and features.'
    },
    {
      icon: '🎨',
      title: 'Theming',
      badge: 'Pro',
      badgeClass: 'badge-warning',
      content: 'Customize colors, spacing, and styles to match your brand.'
    }
  ];

  progressBars = [
    { label: 'Design', value: 90, color: 'var(--primary-orange)' },
    { label: 'Development', value: 75, color: 'var(--info)' },
    { label: 'Testing', value: 60, color: 'var(--success)' },
    { label: 'Deployment', value: 40, color: 'var(--warning)' }
  ];
}
