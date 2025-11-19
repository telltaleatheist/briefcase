import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { VideoWeek } from '../../models/video.model';
import { Library, NewLibrary, RelinkLibrary } from '../../models/library.model';
import { CardComponent } from '../../components/card/card.component';

@Component({
  selector: 'app-files',
  standalone: true,
  imports: [CommonModule, CascadeComponent, LibraryManagerModalComponent, CardComponent],
  templateUrl: './files.component.html',
  styleUrls: ['./files.component.scss']
})
export class FilesComponent {
  // Library manager modal
  showLibraryModal = signal(false);

  // Sample existing libraries
  existingLibraries: Library[] = [
    {
      id: 'lib1',
      name: 'Web Development Tutorials',
      path: '/Users/username/Videos/WebDev',
      videoCount: 45,
      createdDate: new Date('2024-01-15'),
      lastModified: new Date('2024-11-17'),
      size: 5368709120, // 5 GB
      thumbnail: ''
    },
    {
      id: 'lib2',
      name: 'Conference Recordings',
      path: '/Users/username/Videos/Conferences',
      videoCount: 23,
      createdDate: new Date('2024-03-20'),
      lastModified: new Date('2024-11-10'),
      size: 3221225472, // 3 GB
    },
    {
      id: 'lib3',
      name: 'Personal Projects',
      path: '/Users/username/Videos/Projects',
      videoCount: 12,
      createdDate: new Date('2024-06-01'),
      lastModified: new Date('2024-11-05'),
      size: 1610612736, // 1.5 GB
    }
  ];
  // Sample video data organized by weeks
  videoLibrary: VideoWeek[] = [
    {
      weekLabel: 'Week of Nov 11-17, 2024',
      weekNumber: 46,
      videos: [
        {
          id: 'v1',
          name: 'Introduction to Angular Signals.mp4',
          suggestedFilename: '2024-11-15_angular-signals-intro.mp4',
          duration: '01:23:45',
          size: 156789123,
          downloadDate: new Date('2024-11-15')
        },
        {
          id: 'v2',
          name: 'Advanced RxJS Patterns.mp4',
          suggestedFilename: '2024-11-16_rxjs-patterns-advanced.mp4',
          duration: '02:15:30',
          size: 245678901,
          downloadDate: new Date('2024-11-16')
        },
        {
          id: 'v3',
          name: 'Building Reactive Forms.mp4',
          suggestedFilename: '2024-11-17_reactive-forms-guide.mp4',
          duration: '00:45:20',
          size: 98765432,
          downloadDate: new Date('2024-11-17')
        },
        {
          id: 'v4',
          name: 'State Management Best Practices.mp4',
          suggestedFilename: '2024-11-17_state-management-best-practices.mp4',
          duration: '01:05:15',
          size: 123456789,
          downloadDate: new Date('2024-11-17')
        }
      ]
    },
    {
      weekLabel: 'Week of Nov 4-10, 2024',
      weekNumber: 45,
      videos: [
        {
          id: 'v5',
          name: 'TypeScript Deep Dive Part 1.mp4',
          suggestedFilename: '2024-11-05_typescript-deep-dive-pt1.mp4',
          duration: '01:45:00',
          size: 187654321,
          downloadDate: new Date('2024-11-05')
        },
        {
          id: 'v6',
          name: 'TypeScript Deep Dive Part 2.mp4',
          suggestedFilename: '2024-11-06_typescript-deep-dive-pt2.mp4',
          duration: '01:52:30',
          size: 198765432,
          downloadDate: new Date('2024-11-06')
        },
        {
          id: 'v7',
          name: 'CSS Grid Layout Tutorial.mp4',
          suggestedFilename: '2024-11-08_css-grid-layout-tutorial.mp4',
          duration: '00:55:45',
          size: 112345678,
          downloadDate: new Date('2024-11-08')
        },
        {
          id: 'v8',
          name: 'Modern JavaScript Features.mp4',
          suggestedFilename: '2024-11-09_modern-js-features.mp4',
          duration: '01:30:20',
          size: 156789012,
          downloadDate: new Date('2024-11-09')
        },
        {
          id: 'v9',
          name: 'Performance Optimization Tips.mp4',
          suggestedFilename: '2024-11-10_performance-optimization.mp4',
          duration: '01:15:00',
          size: 134567890,
          downloadDate: new Date('2024-11-10')
        }
      ]
    },
    {
      weekLabel: 'Week of Oct 28 - Nov 3, 2024',
      weekNumber: 44,
      videos: [
        {
          id: 'v10',
          name: 'Docker for Developers.mp4',
          suggestedFilename: '2024-10-30_docker-for-developers.mp4',
          duration: '02:05:15',
          size: 223456789,
          downloadDate: new Date('2024-10-30')
        },
        {
          id: 'v11',
          name: 'Git Advanced Techniques.mp4',
          suggestedFilename: '2024-11-01_git-advanced-techniques.mp4',
          duration: '01:20:45',
          size: 145678901,
          downloadDate: new Date('2024-11-01')
        },
        {
          id: 'v12',
          name: 'API Design Best Practices.mp4',
          suggestedFilename: '2024-11-02_api-design-best-practices.mp4',
          duration: '01:35:30',
          size: 167890123,
          downloadDate: new Date('2024-11-02')
        }
      ]
    }
  ];

  features = [
    '🎬 Week-based organization with dividers',
    '🖱️ Multi-select videos (Ctrl/Cmd + click)',
    '✏️ Click suggested filename to edit',
    '🗑️ Quick delete with X button',
    '⏱️ Video duration display (hh:mm:ss)',
    '📊 File size information',
    '✨ Right-click context menu',
    '🎨 Beautiful cascade layout'
  ];

  // Open library manager modal
  openLibraryManager() {
    this.showLibraryModal.set(true);
  }

  // Close library manager modal
  closeLibraryModal() {
    this.showLibraryModal.set(false);
  }

  // Handle library selection
  onLibrarySelected(library: Library) {
    console.log('Selected library:', library);
    // Here you would load the library's videos
    alert(`Selected library: ${library.name}\nPath: ${library.path}`);
  }

  // Handle library creation
  onLibraryCreated(newLibrary: NewLibrary) {
    console.log('Created library:', newLibrary);
    // Here you would create the library and add it to the list
    alert(`Created new library: ${newLibrary.name}\nPath: ${newLibrary.path}`);
  }

  // Handle library relink
  onLibraryRelinked(relinkData: RelinkLibrary) {
    console.log('Relinked library:', relinkData);
    // Here you would scan the folder and load the existing library
    alert(`Relinking to library at:\n${relinkData.path}`);
  }
}
