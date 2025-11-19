import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class NavigationService {
  // Whether the side nav is visible
  navVisible = signal(true);

  showNav() {
    this.navVisible.set(true);
  }

  hideNav() {
    this.navVisible.set(false);
  }

  toggleNav() {
    this.navVisible.update(v => !v);
  }
}
