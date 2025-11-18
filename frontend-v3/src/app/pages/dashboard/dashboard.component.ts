import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardComponent } from '../../components/card/card.component';
import { ButtonComponent } from '../../components/button/button.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, CardComponent, ButtonComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent {
  metrics = [
    {
      label: 'Total Users',
      value: '12,543',
      change: '+12.5%',
      trend: 'up',
      icon: '👥',
      color: '#3b82f6'
    },
    {
      label: 'Revenue',
      value: '$45,231',
      change: '+23.1%',
      trend: 'up',
      icon: '💰',
      color: '#22c55e'
    },
    {
      label: 'Conversion',
      value: '3.24%',
      change: '+0.4%',
      trend: 'up',
      icon: '📈',
      color: '#f59e0b'
    },
    {
      label: 'Active Now',
      value: '573',
      change: '-2.3%',
      trend: 'down',
      icon: '⚡',
      color: '#ef4444'
    }
  ];

  recentActivity = [
    {
      user: 'Sarah Johnson',
      action: 'completed onboarding',
      time: '2 minutes ago',
      avatar: '👩'
    },
    {
      user: 'Mike Chen',
      action: 'made a purchase',
      time: '15 minutes ago',
      avatar: '👨'
    },
    {
      user: 'Emma Davis',
      action: 'left a review',
      time: '1 hour ago',
      avatar: '👩‍🦰'
    },
    {
      user: 'Alex Smith',
      action: 'shared content',
      time: '3 hours ago',
      avatar: '🧑'
    }
  ];

  quickActions = [
    { icon: '➕', label: 'Create New', color: 'var(--primary-orange)' },
    { icon: '📊', label: 'View Reports', color: 'var(--info)' },
    { icon: '⚙️', label: 'Settings', color: 'var(--text-secondary)' },
    { icon: '💬', label: 'Messages', color: 'var(--success)' }
  ];
}
