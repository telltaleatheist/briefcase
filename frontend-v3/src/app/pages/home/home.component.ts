import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { CardComponent } from '../../components/card/card.component';
import { ButtonComponent } from '../../components/button/button.component';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterModule, CardComponent, ButtonComponent],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent {
  features = [
    {
      icon: '🎨',
      title: 'Beautiful Design',
      description: 'Stunning components crafted with attention to detail and modern aesthetics.',
      badge: 'Premium',
      badgeClass: 'badge-success'
    },
    {
      icon: '🌓',
      title: 'Light & Dark Mode',
      description: 'Seamless theme switching with beautiful transitions and consistent styling.',
      badge: 'Featured',
      badgeClass: 'badge-info'
    },
    {
      icon: '⚡',
      title: 'Blazing Fast',
      description: 'Optimized performance with Angular\'s latest features and best practices.',
      badge: 'New',
      badgeClass: 'badge-warning'
    },
    {
      icon: '📱',
      title: 'Fully Responsive',
      description: 'Perfect experience across all devices from mobile to desktop.',
      badge: 'Essential',
      badgeClass: 'badge-success'
    },
    {
      icon: '🧩',
      title: 'Modular Components',
      description: 'Reusable, standalone components that work independently or together.',
      badge: 'Pro',
      badgeClass: 'badge-info'
    },
    {
      icon: '✨',
      title: 'Smooth Animations',
      description: 'Delightful micro-interactions and transitions throughout the app.',
      badge: 'Premium',
      badgeClass: 'badge-success'
    }
  ];

  stats = [
    { value: '50+', label: 'Components', icon: '🧩' },
    { value: '100%', label: 'Responsive', icon: '📱' },
    { value: '2', label: 'Themes', icon: '🎨' },
    { value: '∞', label: 'Possibilities', icon: '✨' }
  ];
}
