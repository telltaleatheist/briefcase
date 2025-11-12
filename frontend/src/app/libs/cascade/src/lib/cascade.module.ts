import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';

import { CascadeListComponent } from './components/cascade-list/cascade-list.component';

@NgModule({
  declarations: [
    CascadeListComponent
  ],
  imports: [
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    MatMenuModule
  ],
  exports: [
    CascadeListComponent
  ]
})
export class CascadeModule { }
