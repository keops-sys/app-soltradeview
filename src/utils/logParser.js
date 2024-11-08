function parseLogFile(logContent) {
    const logs = [];
    const lines = logContent.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
        try {
            const [timestamp, level, message, ...rest] = line.match(/\[(.*?)\] (\w+): (.*)/);
            const metadata = JSON.parse(rest.join('') || '{}');
            
            logs.push({
                timestamp: timestamp.replace(/[\[\]]/g, ''),
                type: level,
                action: metadata.metadata?.action || 'N/A',
                details: message,
                metadata: metadata.metadata || {}
            });
        } catch (error) {
            console.error('Error parsing log line:', error);
        }
    }
    
    return logs;
}

module.exports = { parseLogFile }; 