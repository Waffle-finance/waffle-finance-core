import { useState } from 'react';
import { useToast } from './Toast';
import { getFaucets, isTestnet } from '../config/networks';
import { featureFlags } from '../config/feature-flags';

interface TestnetFaucetProps {
  ethAddress?: string;
  stellarAddress?: string;
}

export default function TestnetFaucet({ ethAddress, stellarAddress }: TestnetFaucetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const toast = useToast();

  // Only show faucets on testnet
  if (!featureFlags.testnetFaucets || !isTestnet()) {
    return null;
  }

  const faucetConfig = getFaucets();
  const faucets = [
    ...faucetConfig.ethereum.map(faucet => ({
      ...faucet,
      network: 'ethereum',
      icon: '🦊'
    })),
    ...faucetConfig.stellar.map(faucet => ({
      ...faucet,
      network: 'stellar',
      icon: '⭐'
    }))
  ];

  const copyAddress = (address: string, type: string) => {
    navigator.clipboard.writeText(address);
    toast.success('Address Copied!', `${type} address copied to clipboard!`);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
                    className="button-hover-scale flex items-center gap-2 rounded-lg border border-cyan-200/25 bg-cyan-200/[0.12] px-3 py-1.5 text-sm text-cyan-50 transition-colors hover:bg-cyan-200/[0.18]"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" />
        </svg>
        Testnet Faucets
      </button>

      {isOpen && (
        <div className="absolute right-0 z-[100] mt-2 w-80 rounded-xl border border-cyan-200/20 bg-[#070b1c]/95 p-4 shadow-2xl backdrop-blur-xl">
          <h3 className="text-white font-semibold mb-4">Get Testnet Tokens</h3>

          {/* Connected Addresses */}
          {(ethAddress || stellarAddress) && (
            <div className="mb-4 space-y-2">
              <h4 className="text-sm text-gray-400">Your Addresses</h4>
              
              {ethAddress && (
                <div className="flex items-center justify-between bg-white/5 rounded-lg p-2 border border-white/10">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🦊</span>
                    <span className="text-xs text-gray-300 font-mono">
                      {ethAddress.substring(0, 8)}...{ethAddress.substring(ethAddress.length - 6)}
                    </span>
                  </div>
                  <button
                    onClick={() => copyAddress(ethAddress, 'Ethereum')}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                  </button>
                </div>
              )}
              
              {stellarAddress && (
                <div className="flex items-center justify-between bg-white/5 rounded-lg p-2 border border-white/10">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🚀</span>
                    <span className="text-xs text-gray-300 font-mono">
                      {stellarAddress.substring(0, 8)}...{stellarAddress.substring(stellarAddress.length - 6)}
                    </span>
                  </div>
                  <button
                    onClick={() => copyAddress(stellarAddress, 'Stellar')}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Faucet List */}
          <div className="space-y-2">
            <h4 className="text-sm text-gray-400">Available Faucets</h4>
            
            {faucets.map((faucet, index) => (
              <a 
                key={index}
                href={faucet.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-lg p-3 border border-white/10 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xl">{faucet.icon}</span>
                  <div>
                    <div className="text-sm text-white font-medium">{faucet.name}</div>
                    <div className="text-xs text-gray-400">{faucet.description}</div>
                  </div>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-white/10 text-center">
            <span className="text-xs text-gray-400">
              Remember to switch to testnet networks in your wallets
            </span>
          </div>
        </div>
      )}
    </div>
  );
} 
