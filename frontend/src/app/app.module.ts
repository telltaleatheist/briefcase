import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { SocketIoModule, SocketIoConfig } from 'ngx-socket-io';

import { MaterialModule } from './material.module';
import { AppRoutingModule } from './app-routing.module';

// Environment
import { environment } from '../environment/environment';

// Import components
import { AppComponent } from './app.component';
import { BatchDownloadComponent } from './components/batch-download/batch-download.component';
import { DownloadFormComponent } from './components/download-form/download-form.component';
import { SettingsComponent } from './components/settings/settings.component';
import { DownloadHistoryComponent } from './components/download-history/download-history.component';
import { DownloadProgressComponent } from './components/download-progress/download-progress.component';
import { ThemeToggleComponent } from './components/theme-toggle/theme-toggle.component';

// Socket.io configuration
const socketIoConfig: SocketIoConfig = {
  url: environment.apiBaseUrl,
  options: {
    transports: ['websocket']
  }
};

@NgModule({
  declarations: [],
  imports: [
    // Angular and third-party modules
    BrowserModule,
    CommonModule,
    AppRoutingModule,
    BrowserAnimationsModule,
    MaterialModule,
    HttpClientModule,
    FormsModule,
    ReactiveFormsModule,
    SocketIoModule.forRoot(socketIoConfig),
    
    // All standalone components
    AppComponent,
    BatchDownloadComponent,
    DownloadFormComponent,
    SettingsComponent,
    DownloadHistoryComponent,
    DownloadProgressComponent,
    ThemeToggleComponent  // Add the ThemeToggleComponent here
  ],
  bootstrap: [AppComponent]
})
export class AppModule {}