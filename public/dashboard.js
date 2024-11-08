// Dashboard functionality
class Dashboard {
    constructor() {
        this.table = null;
        this.trades = [];
        this.init();
    }

    init() {
        this.initTable();
        this.loadData();
        this.setupRefresh();
    }

    initTable() {
        this.table = $('#tradesTable').DataTable({
            order: [[0, 'desc']],
            columns: [
                { 
                    data: 'timestamp',
                    render: (data) => new Date(data).toLocaleString()
                },
                { 
                    data: 'action',
                    render: (data) => `<span class="px-2 py-1 rounded ${
                        data === 'buy' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }">${data.toUpperCase()}</span>`
                },
                { 
                    data: 'amount',
                    render: (data) => Number(data).toFixed(4)
                },
                { data: 'token' },
                { 
                    data: 'price',
                    render: (data) => `$${Number(data).toFixed(2)}`
                },
                { 
                    data: 'executionTime',
                    render: (data) => `${data}ms`
                },
                { 
                    data: 'txHash',
                    render: (data) => `<a href="https://solscan.io/tx/${data}" 
                        target="_blank" class="text-blue-600 hover:text-blue-800">
                        ${data.substring(0, 8)}...
                    </a>`
                },
                { 
                    data: 'status',
                    render: (data) => `<span class="px-2 py-1 rounded ${
                        data === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }">${data}</span>`
                }
            ]
        });
    }

    async loadData() {
        try {
            const response = await fetch('/api/trades');
            const data = await response.json();
            this.trades = data;
            this.updateTable();
            this.updateWidgets();
            this.updateLastUpdate();
        } catch (error) {
            console.error('Error loading trade data:', error);
        }
    }

    updateTable() {
        this.table.clear();
        this.table.rows.add(this.trades);
        this.table.draw();
    }

    updateWidgets() {
        const summary = this.calculateSummary();
        
        // Update widgets with animation
        this.animateValue('pnlPercent', summary.pnlPercent, '%');
        this.animateValue('pnlUsd', summary.pnlUsd, '$');
        this.animateValue('pnlSol', summary.pnlSol, 'SOL');
    }

    calculateSummary() {
        const completedTrades = this.trades.filter(t => t.status === 'success');
        let totalBuy = 0;
        let totalSell = 0;
        let totalBuyUsd = 0;
        let totalSellUsd = 0;

        completedTrades.forEach(trade => {
            if (trade.action === 'buy') {
                totalBuy += Number(trade.amount);
                totalBuyUsd += Number(trade.amount) * Number(trade.price);
            } else {
                totalSell += Number(trade.amount);
                totalSellUsd += Number(trade.amount) * Number(trade.price);
            }
        });

        const pnlSol = totalSell - totalBuy;
        const pnlUsd = totalSellUsd - totalBuyUsd;
        const pnlPercent = (totalBuyUsd > 0) ? 
            ((totalSellUsd - totalBuyUsd) / totalBuyUsd) * 100 : 0;

        return {
            pnlSol: pnlSol.toFixed(4),
            pnlUsd: pnlUsd.toFixed(2),
            pnlPercent: pnlPercent.toFixed(2)
        };
    }

    animateValue(elementId, value, prefix = '') {
        const element = document.getElementById(elementId);
        const start = Number(element.innerText.replace(/[^0-9.-]+/g, '')) || 0;
        const end = Number(value);
        const duration = 1000;
        const startTime = performance.now();

        const updateValue = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            const current = start + (end - start) * progress;
            element.innerText = `${prefix}${current.toFixed(2)}`;
        };

        updateValue(startTime);
        const timer = setInterval(updateValue, 100);

        setTimeout(() => {
            clearInterval(timer);
        }, duration);
    }
} 