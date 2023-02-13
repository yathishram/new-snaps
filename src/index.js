/* eslint-disable camelcase */
/* eslint-disable require-atomic-updates */
/* eslint-disable no-undef */
const { Mutex } = require('async-mutex');
const ethers = require('ethers');

const checkKeyType = (obj, key, type) => {
  // rome-ignore lint/suspicious/useValidTypeof: <explanation>
  if (key in obj && typeof obj[key] === type) {
    return true;
  }
  return false;
};

// Add state management for snap to maintain API key

async function getAPIKey() {
  const state = await wallet.request({
    method: 'snap_manageState',
    params: ['get'],
  });

  if (
    state === null ||
    (typeof state === 'object' && state.apiKey === undefined)
  ) {
    return {};
  }

  return state.apiKey;
}

async function saveAPIKey(newState) {
  const headers = new Headers();

  headers.append('client_id', newState.id);
  headers.append('Authorization', `Bearer ${newState.key}`);

  const result = await fetch(
    'https://risk-management-staging.api.arda.finance/api/v1/auth/login',
    {
      method: 'POST',
      headers,
    },
  );

  if (result.status === 200) {
    const data = await result.json();
    newState.jwt = data.access_token;
    newState.jwt_timeStamp = Date.now();
    await wallet.request({
      method: 'snap_manageState',
      params: ['update', { apiKey: newState }],
    });
    return newState;
  }
  throw new Error('Invalid API Key');
}

async function getJWT() {
  const apiKey = await getAPIKey();
  const { jwt } = apiKey;
  const { jwt_timeStamp } = apiKey;
  // check if the timestamp is more than 24hrs and return new jwt else return the old one
  if (Date.now() - jwt_timeStamp > 86400000) {
    const newApiKey = await saveAPIKey(apiKey);
    return newApiKey.jwt;
  }
  return jwt;
}

const saveMutex = new Mutex();

module.exports.onRpcRequest = async ({ origin, request }) => {
  console.log('Request: ', request);
  console.log('Origin: ', origin);
  let apiKey;
  let clientId;
  switch (request.method) {
    case 'save_apiKey':
      ({ apiKey, clientId } = request.params);
      await saveMutex.runExclusive(async () => {
        const newApiKey = {
          key: apiKey,
          id: clientId,
        };
        await saveAPIKey(newApiKey);
      });
      break;
    default:
      throw new Error('Method not found.');
  }
};

/**
 *
 * @param {Object} transaction
 * @returns transaction insights
 */
module.exports.onTransaction = async ({ transaction, chainId }) => {
  console.log('Transaction: ', transaction);
  console.log('Chain ID: ', chainId);
  const insights = {
    type: 'Unknown Transaction',
  };
  if (
    // rome-ignore lint/complexity/useSimplifiedLogicExpression: <explanation>
    !checkKeyType(transaction, 'from', 'string') ||
    !checkKeyType(transaction, 'to', 'string') ||
    !checkKeyType(transaction, 'value', 'string') ||
    !checkKeyType(transaction, 'data', 'string') ||
    !checkKeyType(transaction, 'gas', 'string')
  ) {
    return { insights };
  }

  const jwt = await getJWT();

  console.log('JWT: ', jwt);

  const transactionBody = {
    transaction: {
      from: transaction.from,
      to: transaction.to,
      value: transaction.value
        ? Number(ethers.utils.formatEther(transaction.value.toString()))
        : 0,
      data: transaction.data === '0x' ? '' : transaction.data,
      gas: Number(transaction.gas).toString(),
      gas_price: Number(transaction.maxPriorityFeePerGas).toString(),
    },
    metadata: {
      url: '',
    },
  };

  console.log('Transaction Body: ', transactionBody);

  const result = await fetch(
    'https://risk-management-staging.api.arda.finance/api/v1/chains/ETHEREUM/transactions/risk-profiles',
    {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(transactionBody),
    },
  );

  if (result.status === 200) {
    const data = await result.json();
    console.log('Data', data);

    const txType = data.tx_type;
    const counterPartyDetails = data.counterparty_details.name;

    const summaryResult = data.risk_profiles.summary.result;

    return {
      insights: {
        type: txType,
        params: {
          counterPartyDetails,
          summaryResult,
        },
      },
    };
  } else if (result.status !== 200) {
    console.log('Error', result);
    return { insights };
  }

  return { insights };
};
