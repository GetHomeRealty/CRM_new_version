import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="dashboard">
      <header>
        <h1>Dashboard</h1>
        <button onClick={onLogout} className="secondary">
          Log out
        </button>
      </header>
      <p>
        Welcome back, <strong>{user?.name}</strong> 👋
      </p>
      <pre className="user-json">{JSON.stringify(user, null, 2)}</pre>
    </div>
  );
}
