const DEFAULT_CONFIG = {
  DATABRICKS_HOST: 'https://dbc-1223456789.cloud.databricks.com', // 填写工作区host或添加环境变量,变量名：DATABRICKS_HOST
  DATABRICKS_TOKEN: 'dapi6dae4632d66931ecdeefe8808f20bdee'        // 填写token或添加环境变量,变量名：DATABRICKS_TOKEN
};

export default {
  async scheduled(event, env, ctx) {
    console.log('开始检查 Databricks Apps 状态...');
    
    try {
      const config = getConfig(env);
      await checkAndStartApps(config);
      console.log('Databricks Apps 检查完成');
    } catch (error) {
      console.error('检查过程中出错:', error);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 前端页面
    if (path === '/' || path === '/index.html') {
      return new Response(getFrontendHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    // API 端点
    if (path === '/check') {
      try {
        const config = getConfig(env);
        const result = await checkAndStartApps(config);
        return new Response(JSON.stringify({
          success: true,
          message: '检查完成',
          timestamp: new Date().toISOString(),
          results: result
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    if (path === '/start') {
      try {
        const config = getConfig(env);
        const result = await startStoppedApps(config);
        return new Response(JSON.stringify({
          success: true,
          message: '启动操作完成',
          timestamp: new Date().toISOString(),
          results: result
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    if (path === '/status') {
      try {
        const config = getConfig(env);
        const result = await getAppsStatus(config);
        return new Response(JSON.stringify({
          success: true,
          message: '状态获取完成',
          timestamp: new Date().toISOString(),
          results: result
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    if (path === '/config') {
      const config = getConfig(env);
      const maskedToken = config.DATABRICKS_TOKEN ? 
        config.DATABRICKS_TOKEN.substring(0, 10) + '...' : '未设置';
      
      return new Response(JSON.stringify({
        DATABRICKS_HOST: config.DATABRICKS_HOST,
        DATABRICKS_TOKEN: maskedToken,
        source: config.source
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 未知路由
    return new Response(JSON.stringify({
      error: '路由不存在',
      available_routes: [
        { path: '/', method: 'GET', description: '前端管理界面' },
        { path: '/check', method: 'GET', description: '检查并自动启动停止的 Apps' },
        { path: '/start', method: 'POST', description: '手动启动所有停止的 Apps' },
        { path: '/status', method: 'GET', description: '获取当前 Apps 状态' },
        { path: '/config', method: 'GET', description: '查看当前配置' }
      ]
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function getConfig(env) {
  const host = env.DATABRICKS_HOST || DEFAULT_CONFIG.DATABRICKS_HOST;
  const token = env.DATABRICKS_TOKEN || DEFAULT_CONFIG.DATABRICKS_TOKEN;
  
  return {
    DATABRICKS_HOST: host,
    DATABRICKS_TOKEN: token,
    source: {
      host: env.DATABRICKS_HOST ? '环境变量' : '默认值',
      token: env.DATABRICKS_TOKEN ? '环境变量' : '默认值'
    }
  };
}

async function getAppsList(config) {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN } = config;
  
  let allApps = [];
  let pageToken = '';
  
  do {
    let url = `${DATABRICKS_HOST}/api/2.0/apps?page_size=50`;
    if (pageToken) {
      url += `&page_token=${encodeURIComponent(pageToken)}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${DATABRICKS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const apps = data.apps || [];
    
    allApps = allApps.concat(apps);
    pageToken = data.next_page_token || '';
  } while (pageToken);

  return allApps;
}

async function getAppsStatus(config) {
  try {
    const apps = await getAppsList(config);
    
    const results = apps.map(app => ({
      name: app.name,
      id: app.id,
      state: app.compute_status?.state || 'UNKNOWN',
      url: app.url,
      createdAt: app.creation_timestamp,
      lastUpdated: app.last_updated_timestamp
    }));
    
    const summary = {
      total: results.length,
      active: results.filter(app => app.state === 'ACTIVE').length,
      stopped: results.filter(app => app.state === 'STOPPED').length,
      unknown: results.filter(app => app.state === 'UNKNOWN').length,
      other: results.filter(app => !['ACTIVE', 'STOPPED', 'UNKNOWN'].includes(app.state)).length
    };
    
    return {
      summary,
      apps: results
    };
  } catch (error) {
    throw error;
  }
}

async function checkAndStartApps(config) {
  const apps = await getAppsList(config);
  const results = [];
  
  for (const app of apps) {
    const result = await processApp(app, config);
    results.push(result);
  }
  
  return results;
}

async function startStoppedApps(config) {
  const apps = await getAppsList(config);
  const stoppedApps = apps.filter(app => (app.compute_status?.state || 'UNKNOWN') === 'STOPPED');
  const results = [];
  
  console.log(`找到 ${stoppedApps.length} 个停止的 Apps`);
  
  for (const app of stoppedApps) {
    const result = await startSingleApp(app, config);
    results.push(result);
  }
  
  return results;
}

async function processApp(app, config) {
  const appName = app.name;
  const appId = app.id;
  const computeState = app.compute_status?.state || 'UNKNOWN';
  
  console.log(`检查 App: ${appName} (ID: ${appId}) | Compute状态: ${computeState}`);

  if (computeState === 'STOPPED') {
    console.log(`⚡ 启动停止的 App: ${appName}`);
    return await startSingleApp(app, config);
  } else {
    console.log(`✅ App ${appName} 状态正常: ${computeState}`);
    return { 
      app: appName, 
      appId: appId, 
      status: 'healthy', 
      computeState,
      timestamp: new Date().toISOString()
    };
  }
}

async function startSingleApp(app, config) {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN } = config;
  const appName = app.name;
  const appId = app.id;
  
  try {
    const encodedAppName = encodeURIComponent(appName);
    const startUrl = `${DATABRICKS_HOST}/api/2.0/apps/${encodedAppName}/start`;
    
    console.log(`启动 URL: ${startUrl}`);
    
    const startResponse = await fetch(startUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DATABRICKS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const responseText = await startResponse.text();
    console.log(`启动响应: ${responseText}`);

    if (startResponse.ok) {
      console.log(`✅ App ${appName} 启动成功`);
      return { 
        app: appName, 
        appId: appId, 
        status: 'started', 
        success: true,
        timestamp: new Date().toISOString()
      };
    } else {
      console.error(`❌ App ${appName} 启动失败:`, responseText);
      
      let errorDetails;
      try {
        errorDetails = JSON.parse(responseText);
      } catch {
        errorDetails = { message: responseText };
      }
      
      return { 
        app: appName, 
        appId: appId, 
        status: 'start_failed', 
        error: errorDetails,
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.error(`❌ App ${appName} 启动请求错误:`, error);
    return { 
      app: appName, 
      appId: appId, 
      status: 'error', 
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

function getFrontendHTML() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Databricks Apps 监控面板</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #2c3e50, #34495e);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .header p {
            opacity: 0.9;
            font-size: 1.1em;
        }
        
        .controls {
            padding: 25px;
            background: #f8f9fa;
            border-bottom: 1px solid #e9ecef;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            align-items: center;
        }
        
        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn-primary {
            background: #007bff;
            color: white;
        }
        
        .btn-primary:hover {
            background: #0056b3;
            transform: translateY(-2px);
        }
        
        .btn-success {
            background: #28a745;
            color: white;
        }
        
        .btn-success:hover {
            background: #1e7e34;
            transform: translateY(-2px);
        }
        
        .btn-info {
            background: #17a2b8;
            color: white;
        }
        
        .btn-info:hover {
            background: #138496;
            transform: translateY(-2px);
        }
        
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none !important;
        }
        
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 8px;
        }
        
        .status-active { background: #28a745; }
        .status-stopped { background: #dc3545; }
        .status-unknown { background: #ffc107; }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 25px;
            background: white;
        }
        
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            text-align: center;
            border-left: 5px solid #007bff;
        }
        
        .stat-number {
            font-size: 2.5em;
            font-weight: bold;
            color: #2c3e50;
        }
        
        .stat-label {
            color: #6c757d;
            font-size: 0.9em;
            margin-top: 5px;
        }
        
        .apps-list {
            padding: 25px;
        }
        
        .apps-table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        
        .apps-table th,
        .apps-table td {
            padding: 15px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }
        
        .apps-table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #2c3e50;
        }
        
        .apps-table tr:hover {
            background: #f8f9fa;
        }
        
        .state-badge {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
        }
        
        .state-active {
            background: #d4edda;
            color: #155724;
        }
        
        .state-stopped {
            background: #f8d7da;
            color: #721c24;
        }
        
        .state-unknown {
            background: #fff3cd;
            color: #856404;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #6c757d;
        }
        
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
        }
        
        .success {
            background: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
        }
        
        .last-updated {
            text-align: center;
            padding: 15px;
            color: #6c757d;
            font-size: 0.9em;
            border-top: 1px solid #e9ecef;
        }
        
        .routes-info {
            background: #f8f9fa;
            padding: 25px;
            margin-top: 30px;
            border-radius: 8px;
        }
        
        .routes-info h3 {
            margin-bottom: 15px;
            color: #2c3e50;
        }
        
        .route-item {
            background: white;
            padding: 15px;
            margin: 10px 0;
            border-radius: 6px;
            border-left: 4px solid #007bff;
        }
        
        @media (max-width: 768px) {
            .controls {
                flex-direction: column;
                align-items: stretch;
            }
            
            .btn {
                justify-content: center;
            }
            
            .apps-table {
                font-size: 0.9em;
            }
            
            .apps-table th,
            .apps-table td {
                padding: 10px 8px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Databricks Apps 监控面板</h1>
            <p>实时监控和管理你的 Databricks Apps</p>
        </div>
        
        <div class="controls">
            <button class="btn btn-primary" onclick="refreshStatus()">
                🔄 刷新状态
            </button>
            <button class="btn btn-success" onclick="startStoppedApps()">
                ⚡ 启动停止的 Apps
            </button>
            <button class="btn btn-info" onclick="checkAndStart()">
                🔍 检查并自动启动
            </button>
            <div style="margin-left: auto; display: flex; align-items: center; gap: 10px;">
                <span id="lastUpdated">-</span>
                <div id="loadingIndicator" style="display: none;">
                    <span>加载中...</span>
                </div>
            </div>
        </div>
        
        <div id="messageContainer"></div>
        
        <div class="stats" id="statsContainer">
            <div class="loading">加载统计数据...</div>
        </div>
        
        <div class="apps-list">
            <h2 style="margin-bottom: 20px; color: #2c3e50;">Apps 列表</h2>
            <div id="appsContainer">
                <div class="loading">加载 Apps 列表...</div>
            </div>
        </div>
        
        <div class="last-updated">
            最后更新: <span id="updateTime">-</span>
        </div>
        
        <div class="routes-info">
            <h3>📚 API 路由说明</h3>
            <div class="route-item">
                <strong>GET /</strong> - 显示此管理界面
            </div>
            <div class="route-item">
                <strong>GET /status</strong> - 获取当前所有 Apps 的状态
            </div>
            <div class="route-item">
                <strong>GET /check</strong> - 检查并自动启动停止的 Apps
            </div>
            <div class="route-item">
                <strong>POST /start</strong> - 手动启动所有停止的 Apps
            </div>
            <div class="route-item">
                <strong>GET /config</strong> - 查看当前配置信息
            </div>
        </div>
    </div>

    <script>
        let currentData = null;
        
        // 页面加载时获取状态
        document.addEventListener('DOMContentLoaded', function() {
            refreshStatus();
        });
        
        // 显示消息
        function showMessage(message, type = 'info') {
            const container = document.getElementById('messageContainer');
            const messageEl = document.createElement('div');
            messageEl.className = type === 'error' ? 'error' : 'success';
            messageEl.textContent = message;
            container.appendChild(messageEl);
            
            // 3秒后自动移除
            setTimeout(() => {
                messageEl.remove();
            }, 5000);
        }
        
        // 显示加载状态
        function setLoading(loading) {
            const indicator = document.getElementById('loadingIndicator');
            const buttons = document.querySelectorAll('.btn');
            
            if (loading) {
                indicator.style.display = 'block';
                buttons.forEach(btn => btn.disabled = true);
            } else {
                indicator.style.display = 'none';
                buttons.forEach(btn => btn.disabled = false);
            }
        }
        
        // 刷新状态
        async function refreshStatus() {
            setLoading(true);
            try {
                const response = await fetch('/status');
                const data = await response.json();
                
                if (data.success) {
                    currentData = data;
                    updateStats(data.results);
                    updateAppsList(data.results);
                    updateLastUpdated();
                    showMessage('状态刷新成功', 'success');
                } else {
                    showMessage('刷新失败: ' + data.error, 'error');
                }
            } catch (error) {
                showMessage('请求失败: ' + error.message, 'error');
            } finally {
                setLoading(false);
            }
        }
        
        // 启动停止的 Apps
        async function startStoppedApps() {
            if (!confirm('确定要启动所有停止的 Apps 吗？')) return;
            
            setLoading(true);
            try {
                const response = await fetch('/start', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                    showMessage('启动操作完成', 'success');
                    // 刷新状态显示最新结果
                    setTimeout(refreshStatus, 2000);
                } else {
                    showMessage('启动失败: ' + data.error, 'error');
                }
            } catch (error) {
                showMessage('请求失败: ' + error.message, 'error');
            } finally {
                setLoading(false);
            }
        }
        
        // 检查并自动启动
        async function checkAndStart() {
            setLoading(true);
            try {
                const response = await fetch('/check');
                const data = await response.json();
                
                if (data.success) {
                    showMessage('检查完成', 'success');
                    // 刷新状态显示最新结果
                    setTimeout(refreshStatus, 2000);
                } else {
                    showMessage('检查失败: ' + data.error, 'error');
                }
            } catch (error) {
                showMessage('请求失败: ' + error.message, 'error');
            } finally {
                setLoading(false);
            }
        }
        
        // 更新统计信息
        function updateStats(data) {
            const container = document.getElementById('statsContainer');
            const { summary } = data;
            
            container.innerHTML = \`
                <div class="stat-card">
                    <div class="stat-number">\${summary.total}</div>
                    <div class="stat-label">总 Apps 数量</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color: #28a745;">\${summary.active}</div>
                    <div class="stat-label">运行中</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color: #dc3545;">\${summary.stopped}</div>
                    <div class="stat-label">已停止</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color: #ffc107;">\${summary.unknown}</div>
                    <div class="stat-label">状态未知</div>
                </div>
            \`;
        }
        
        // 更新 Apps 列表
        function updateAppsList(data) {
            const container = document.getElementById('appsContainer');
            const { apps } = data;
            
            if (apps.length === 0) {
                container.innerHTML = '<div class="loading">没有找到任何 Apps</div>';
                return;
            }
            
            let html = \`
                <table class="apps-table">
                    <thead>
                        <tr>
                            <th>App 名称</th>
                            <th>状态</th>
                            <th>App ID</th>
                            <th>创建时间</th>
                        </tr>
                    </thead>
                    <tbody>
            \`;
            
            apps.forEach(app => {
                const stateClass = \`state-\${app.state.toLowerCase()}\`;
                const createDate = app.createdAt ? new Date(app.createdAt).toLocaleString() : '未知';
                
                html += \`
                    <tr>
                        <td><strong>\${app.name}</strong></td>
                        <td>
                            <span class="state-badge \${stateClass}">
                                \${app.state}
                            </span>
                        </td>
                        <td><code>\${app.id}</code></td>
                        <td>\${createDate}</td>
                    </tr>
                \`;
            });
            
            html += '</tbody></table>';
            container.innerHTML = html;
        }
        
        // 更新最后更新时间
        function updateLastUpdated() {
            const now = new Date();
            document.getElementById('updateTime').textContent = now.toLocaleString();
            document.getElementById('lastUpdated').textContent = '最后更新: ' + now.toLocaleTimeString();
        }
        
        // 每2分钟自动刷新一次
        setInterval(refreshStatus, 2 * 60 * 1000);
    </script>
</body>
</html>
  `;
}
