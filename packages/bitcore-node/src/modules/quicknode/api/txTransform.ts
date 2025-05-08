/*
interface SolanaTransaction {
  meta: {
      fee: number;
      err: any;
      status: { Ok: null } | { Err: any };
      postBalances: number[];
      preBalances: number[];
  };
  transaction: {
      message: {
          accountKeys: Array<{
              pubkey: string;
              signer: boolean;
              writable: boolean;
          }>;
          instructions: Array<{
              program?: string;
              programId: string;
              parsed?: {
                  type: string;
                  info: any;
              };
          }>;
          recentBlockhash: string;
      };
      signatures: string[];
  };
}

interface WalletTransaction {
  // Essential identification
  signature: string;
  timestamp?: number;  // Added: Users often want to know when the transaction occurred
  blockHash: string;
  // Core transaction details
  status: 'confirmed' | 'failed';  // More user-friendly than boolean
  amount: number;     // The actual transaction amount (separate from fees)
  fee: number;
  
  // Participant addresses
  sender: string;     // The sending address
  recipient?: string; // The receiving address (if applicable)
  
  // User-friendly information
  type: 'send' | 'receive' | 'vote' | 'other';  // Simplified transaction types
  description?: string;  // Human readable description of the transaction
}

interface WalletTransaction {
  signature: string;
  success: boolean;
  fee: number;
  blockHash: string;
  from: string;
  program: string;
  type: string;
  balanceChange: number;
}

function transformTransactionForWallet(tx: SolanaTransaction): WalletTransaction {
  const signer = tx.transaction.message.accountKeys.find(key => key.signer)?.pubkey || '';
  const preBalance = tx.meta.preBalances[0];
  const postBalance = tx.meta.postBalances[0];

  return {
      signature: tx.transaction.signatures[0],
      status: tx.meta.status.Ok !== undefined ? 'confirmed' : 'failed',
      amount: Math.abs(postBalance - preBalance - tx.meta.fee),
      fee: tx.meta.fee,
      sender: signer,
      type: determineTransactionType(tx),
      description: generateTransactionDescription(tx)
  };
}

// Helper function to determine user-friendly transaction type
function determineTransactionType(tx: SolanaTransaction): 'send' | 'receive' | 'vote' | 'other' {
  if (tx.transaction.message.instructions[0].programId === 'Vote111111111111111111111111111111111111111') {
      return 'vote';
  }
  // Add other type determinations as needed
  return 'other';
}

// Helper function to generate human-readable description
function generateTransactionDescription(tx: SolanaTransaction): string {
  // Generate user-friendly description based on transaction type and details
  if (tx.transaction.message.instructions[0].programId === 'Vote111111111111111111111111111111111111111') {
      return 'Vote Transaction';
  }
  return 'Transaction';
}





type TransformedTransaction = {
  txid: string;
  network: string;
  chain: string;
  blockHeight: number | null;
  blockHash: string;
  recentBlockhash: string;
  blockTime: string | null;
  blockTimeNormalized: string | null;
  fee: number;
  value: string;
  to: string | null;
  from: string | null;
  meta: string; // Base64 encoded
  message: string; // Base64 encoded
};

function transformTransactionData(data: any): TransformedTransaction {
  const {
    transaction: {
      signatures,
      message,
    },
    meta,
    slot,
    blockTime,
  } = data;

  const { accountKeys, recentBlockhash } = message;

  // Convert blockTime to ISO string if available
  const blockTimeISO = blockTime ? new Date(blockTime * 1000).toISOString() : null;

  // Determine 'from' address (first signer)
  const fromAccount = accountKeys.find((account: any) => account.signer);
  const from = fromAccount ? fromAccount.pubkey : null;

  // Attempt to determine 'to' address from instructions
  let to: string | null = null;
  if (message.instructions && message.instructions.length > 0) {
    const instruction = message.instructions[0];
    // For parsed transfer instructions
    if (instruction.parsed && instruction.parsed.info && instruction.parsed.info.destination) {
      to = instruction.parsed.info.destination;
    } else if (instruction.accounts && instruction.accounts.length > 1) {
      // Assuming the second account is the recipient
      to = instruction.accounts[1];
    }
  }

  // Calculate the value transferred (in lamports)
  let value = '0';
  if (
    meta.preBalances &&
    meta.postBalances &&
    meta.preBalances.length === meta.postBalances.length
  ) {
    // Find the index of the 'from' account
    const fromIndex = accountKeys.findIndex((account: any) => account.pubkey === from);
    if (fromIndex !== -1) {
      const valueTransferred = meta.preBalances[fromIndex] - meta.postBalances[fromIndex] - meta.fee;
      value = valueTransferred.toString();
    }
  }

  // Encode meta and message as Base64 strings to compress size
  const metaString = Buffer.from(JSON.stringify(meta)).toString('base64');
  const messageString = Buffer.from(JSON.stringify(message)).toString('base64');

  return {
    txid: signatures[0],
    network: "mainnet", // added after
    chain: "SOL", // added after
    blockHeight: slot || null,
    blockHash: recentBlockhash,
    recentBlockhash,
    blockTime: blockTimeISO,
    blockTimeNormalized: blockTimeISO,
    fee: meta.fee,
    value,
    to,
    from,
    meta: metaString,
    message: messageString,
  };
}


----------------------------------------------------------------


*/



// const block = inputData[0]; // stream specific

function transformData(params, network) {  
  let height;
  let blockTime;
  let blockHash;
  let { block, transactions, txStatuses } = params;
  // block level
  if (block) {
    ({ blockHeight: height, blockTime, blockhash: blockHash } = block);
  }
  transactions = transactions || block.transactions;
  
  return transactions.map((tx, index) => {
    blockTime = blockTime || tx?.blockTime

    const { meta, transaction, version } = tx;
    const txStatus = txStatuses?.[index];
    const slot = meta.slot || height || txStatus?.slot;
    const recentBlockhash = transaction.message.recentBlockhash || blockHash;
    const txid = transaction.signatures[0] || txStatus?.signature;
    const date = new Date((blockTime || 0) * 1000);
    const status = tx?.confirmationStatus || txStatus?.confirmationStatus;

    const fee = meta.fee;
    const feePayer = transaction.message.accountKeys.find((key) => key.signer)?.pubkey || '';
    const transactionError = meta.err ? { error: JSON.stringify(meta.err) } : null;
    const txType = version;
    // find instructions with parsed data
    const instruction = transaction.message.instructions?.find((key) => key.parsed)?.parsed;
    const category = instruction?.type;
    const to = instruction?.info?.destination;
    const value = Number(instruction?.info?.lamports) || 0;
    const tokenTransfers: any = []
    const accountData: any = [];
    const instructions: any = [];

    // Process instructions
    for (const instruction of transaction.message.instructions) {
      // Collect instruction data
      const outputInstruction = {
        accounts: instruction.accounts || [],
        data: instruction.data,
        programId: instruction.programId || '',
      };
      instructions.push(outputInstruction);
    }
    // Process token transfers
    if (meta.preTokenBalances.length > 0 && meta.postTokenBalances.length > 0) {
      for (const preTokenBalance of meta.preTokenBalances) {
        const postTokenBalance = meta.postTokenBalances.find(
          (ptb) => ptb.accountIndex === preTokenBalance.accountIndex && ptb.mint === preTokenBalance.mint
        );

        if (postTokenBalance) {
          const tokenAmountChange =
            Number(postTokenBalance.uiTokenAmount.amount) - Number(preTokenBalance.uiTokenAmount.amount);
          if (tokenAmountChange !== 0) {
            const fromTokenAccount = transaction.message.accountKeys[preTokenBalance.accountIndex].pubkey;
            const toTokenAccount = transaction.message.accountKeys[postTokenBalance.accountIndex].pubkey;

            tokenTransfers.push({
              fromTokenAccount,
              toTokenAccount,
              tokenAmount: tokenAmountChange,
              mint: preTokenBalance.mint,
            });
          }
        }
      }
    }
    // Process account data
    for (const [index, accountKey] of transaction.message.accountKeys.entries()) {
      const preBalance = meta.preBalances[index];
      const postBalance = meta.postBalances[index];
      const balanceChange = postBalance - preBalance;

      const _accountData = {
        account: accountKey.pubkey,
        nativeBalanceChange: balanceChange,
      };

      accountData.push(_accountData);
    };

    const outputTx = {
      chain: 'SOL',
      network,
      txid,
      category,
      from: feePayer,
      to,
      value,
      fee,
      status,
      txType,
      blockHeight: slot,
      blockHash: recentBlockhash,
      blockTime: date,
      blockTimeNormalized: date,
      error: transactionError,
      tokenTransfers,
      accountData,
      instructions
    };

    return outputTx;
  });

  // return {
  //   blockTime,
  //   blockHash,
  //   blockHeight,
  //   transactions: transformedTransactions,
  // };
}