import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DashboardMenu } from './components/DashboardMenu';
import { shouldShowDashboardMenu } from './utils/dashboardModes.mjs';
import './style.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {shouldShowDashboardMenu(window.location.search) ? <DashboardMenu /> : <App />}
  </React.StrictMode>
);
