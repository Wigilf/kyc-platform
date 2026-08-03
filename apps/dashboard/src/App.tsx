import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { clearSession, loadSession } from './api';
import Applicants from './pages/Applicants';
import ApplicantDetail from './pages/ApplicantDetail';
import Cases from './pages/Cases';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Rules from './pages/Rules';
import Screening from './pages/Screening';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/applicants', label: 'Applicants' },
  { to: '/cases', label: 'Cases' },
  { to: '/screening', label: 'Screening' },
  { to: '/rules', label: 'Rules' },
];

function Shell() {
  const navigate = useNavigate();
  const session = loadSession();
  if (!session) return <Navigate to="/login" replace />;

  function signOut() {
    clearSession();
    navigate('/login', { replace: true });
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          KYC Operations
          <small>{session.tenant.name}</small>
        </div>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          <div>{session.user.name ?? session.user.email}</div>
          <div style={{ marginBottom: 8 }}>{session.user.role.replace(/_/g, ' ').toLowerCase()}</div>
          <button onClick={signOut} style={{ padding: '4px 10px', fontSize: 12 }}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="applicants" element={<Applicants />} />
        <Route path="applicants/:id" element={<ApplicantDetail />} />
        <Route path="cases" element={<Cases />} />
        <Route path="screening" element={<Screening />} />
        <Route path="rules" element={<Rules />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
