import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardComponent } from '../../components/card/card.component';

@Component({
  selector: 'app-gallery',
  standalone: true,
  imports: [CommonModule, CardComponent],
  templateUrl: './gallery.component.html',
  styleUrls: ['./gallery.component.scss']
})
export class GalleryComponent {
  galleryItems = [
    {
      id: 1,
      title: 'Abstract Shapes',
      category: 'Design',
      color: '#ff6b35',
      emoji: '🎨'
    },
    {
      id: 2,
      title: 'Gradient Dreams',
      category: 'Art',
      color: '#3b82f6',
      emoji: '🌈'
    },
    {
      id: 3,
      title: 'Geometric Patterns',
      category: 'Design',
      color: '#22c55e',
      emoji: '🔶'
    },
    {
      id: 4,
      title: 'Fluid Motion',
      category: 'Animation',
      color: '#f59e0b',
      emoji: '💫'
    },
    {
      id: 5,
      title: 'Sunset Vibes',
      category: 'Photography',
      color: '#ff8c5a',
      emoji: '🌅'
    },
    {
      id: 6,
      title: 'Neon Lights',
      category: 'Design',
      color: '#a855f7',
      emoji: '✨'
    },
    {
      id: 7,
      title: 'Ocean Waves',
      category: 'Nature',
      color: '#06b6d4',
      emoji: '🌊'
    },
    {
      id: 8,
      title: 'Mountain Peak',
      category: 'Photography',
      color: '#64748b',
      emoji: '⛰️'
    },
    {
      id: 9,
      title: 'Cosmic Space',
      category: 'Art',
      color: '#1e293b',
      emoji: '🌌'
    }
  ];

  categories = ['All', 'Design', 'Art', 'Photography', 'Animation', 'Nature'];
  selectedCategory = 'All';

  get filteredItems() {
    if (this.selectedCategory === 'All') {
      return this.galleryItems;
    }
    return this.galleryItems.filter(item => item.category === this.selectedCategory);
  }

  selectCategory(category: string) {
    this.selectedCategory = category;
  }
}
