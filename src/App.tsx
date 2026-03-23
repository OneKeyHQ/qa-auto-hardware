import { useState } from 'react';
import CameraPanel from './components/CameraPanel';
import ControlPanel from './components/ControlPanel';
import McpLogsPanel from './components/McpLogsPanel';
import './styles/App.css';

type TabId = 'control' | 'mcp-logs';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('control');

  return (
    <div className="app">
      <div className="app-title-bar" />
      <div className="app-content">
        <div className="camera-section">
          <CameraPanel />
        </div>

        <div className="main-section">
          <div className="tab-header">
            <button
              className={`tab-btn ${activeTab === 'control' ? 'active' : ''}`}
              onClick={() => setActiveTab('control')}
            >
              钱包操作
            </button>
            <button
              className={`tab-btn ${activeTab === 'mcp-logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('mcp-logs')}
            >
              MCP Logs
            </button>
          </div>
          <div className="tab-content">
            {activeTab === 'control' && <ControlPanel />}
            {activeTab === 'mcp-logs' && <McpLogsPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
