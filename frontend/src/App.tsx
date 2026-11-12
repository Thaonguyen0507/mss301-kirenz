/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import Login from './Login';
import Register from './Register';
import ProfileSettings from './ProfileSettings';
import UserProfile from './UserProfile';
import HomeFeed from './HomeFeed';
import Explore from './Explore';
import Chat from './Chat';
import EditCover from './EditCover';
import BlockedUsers from './BlockedUsers';
import VisitorFeed from './VisitorFeed';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import PublicRoute from './components/PublicRoute';
import Dashboard from './Dashboard';
import AdminLayout from './components/AdminLayout';
import UserManagement from './UserManagement';
import Reports from './Reports';
import Monitoring from './Monitoring';
import Audit from './Audit';
import ModerationDetailPage from './ModerationDetail';
import { initTheme } from './utils/theme';
import { VideoCallProvider } from './components/calls/VideoCallProvider';

export default function App() {
  useEffect(() => {
    initTheme();
  }, []);

  return (
    <BrowserRouter>
      <VideoCallProvider>
      <div className="fixed top-0 left-0 right-0 bg-surface-container border-b border-outline-variant p-2 flex justify-center gap-4 z-[100] text-sm hidden">
        <Link to="/login" className="text-primary font-bold hover:underline">Login</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/register" className="text-primary font-bold hover:underline">Register</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/home" className="text-primary font-bold hover:underline">Home Feed</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/explore" className="text-primary font-bold hover:underline">Explore</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/profile" className="text-primary font-bold hover:underline">Profile</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/chat" className="text-primary font-bold hover:underline">Chat</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/settings" className="text-primary font-bold hover:underline">Settings</Link>
        <span className="text-on-surface-variant">|</span>
        <Link to="/blocked" className="text-primary font-bold hover:underline">Blocked</Link>
      </div>
      <div>
        <Routes>
          <Route path="/" element={<PublicRoute><VisitorFeed /></PublicRoute>} />
          <Route path="/posts/:postId" element={<PublicRoute><VisitorFeed /></PublicRoute>} />
          <Route path="/login" element={<PublicRoute allowUnverified><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/home" element={<ProtectedRoute><HomeFeed /></ProtectedRoute>} />
          <Route path="/explore" element={<ProtectedRoute><Explore /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><UserProfile /></ProtectedRoute>} />
          <Route path="/profile/:userId" element={<ProtectedRoute><UserProfile /></ProtectedRoute>} />
          <Route path="/edit-cover" element={<ProtectedRoute><EditCover /></ProtectedRoute>} />
          <Route path="/chat" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
          <Route path="/friends" element={<Navigate to="/profile?tab=friends" replace />} />
          <Route path="/stories" element={<Navigate to="/home" replace />} />
          <Route path="/story/:id" element={<Navigate to="/home" replace />} />
          <Route path="/settings" element={<ProtectedRoute><ProfileSettings /></ProtectedRoute>} />
          <Route path="/privacy" element={<Navigate to="/settings" replace />} />
          <Route path="/blocked" element={<ProtectedRoute><BlockedUsers /></ProtectedRoute>} />
          <Route path="/moderation/:actionId" element={<ProtectedRoute><ModerationDetailPage /></ProtectedRoute>} />
          <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="users" element={<UserManagement />} />
            <Route path="reports" element={<Reports />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="audit" element={<Audit />} />
          </Route>
        </Routes>
      </div>
      </VideoCallProvider>
    </BrowserRouter>
  );
}


