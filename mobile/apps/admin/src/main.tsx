import React from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApi, sessionTokenStore } from './api';
import { ConsoleApp } from './App';
import './styles.css';

const api = new AdminApi(window.location.origin, sessionTokenStore());
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConsoleApp api={api} /></React.StrictMode>);
