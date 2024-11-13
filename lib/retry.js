// Utility functions for handling retries and rate limiting

/**
 * Retries RPC operations with exponential backoff
 * @param {Function} operation - Async function that performs the RPC call
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<any>} - Result of the operation
 */
export async function rpcWithRetry(operation, connectionPool, currentConnectionIndex, maxRetries = 5) {
  let retryCount = 0;
  let delay = 100000; // Start with 10s delay

  while (retryCount < maxRetries) {
    try {
      return await operation(connectionPool[currentConnectionIndex]);
    } catch (error) {
      if (!error.message.includes('429 Too Many Requests')) {
        throw error;
      }
      
      retryCount++;
      console.log(`RPC rate limited. Switching endpoint and retrying ${retryCount}/${maxRetries}`);
      
      // Switch to next connection before retry
      currentConnectionIndex = (currentConnectionIndex + 1) % connectionPool.length;
      console.log(`Switched to RPC endpoint ${currentConnectionIndex + 1}/${connectionPool.length}`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('Max retries reached on all endpoints');
}

/**
 * Retries fetch operations with exponential backoff
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Response>} - Fetch response
 */
export async function fetchWithRetry(url, options = {}, maxRetries = 5) {
  let retryCount = 0;
  let delay = 50000; // Start with 50s delay

  while (retryCount < maxRetries) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 429) {
        return response;
      }
      
      retryCount++;
      console.log(`Rate limited (429). Retry ${retryCount}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    } catch (error) {
      if (retryCount === maxRetries - 1) throw error;
      retryCount++;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('Max retries reached');
} 