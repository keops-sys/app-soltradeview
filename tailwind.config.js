module.exports = {
  theme: {
    extend: {
      animation: {
        'infinite-scroll': 'infinite-scroll 25s linear infinite',
      },
      keyframes: {
        'infinite-scroll': {
          'from': { transform: 'translateX(0)' },
          'to': { transform: 'translateX(calc(-100% - 1rem))' }
        }
      },
    },
  },
  // ... rest of your config
} 