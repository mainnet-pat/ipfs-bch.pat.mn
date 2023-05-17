import Head from 'next/head'
import styles from '@/styles/Home.module.css'
import Image from 'next/image'
import { DefaultProvider, NFTCapability, OpReturnData, TestNetWallet, Wallet, binToHex, qrAddress } from 'mainnet-js'
import { useCallback, useEffect, useState } from 'react';
import { useDebounce } from "use-debounce";
import axios from "axios";
import { CashAddressNetworkPrefix, binToNumberUint16LE, binToNumberUint32LE, binToUtf8, decodeCashAddress, encodeCashAddress, hexToBin, numberToBinInt16LE, numberToBinInt32LE } from '@bitauth/libauth';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { githubGist } from 'react-syntax-highlighter/dist/cjs/styles/hljs';

const isTestnet = false;
const WalletClass = isTestnet ? TestNetWallet : Wallet;

const convertCashaddr = (address: string): string => {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === "string") {
    throw decoded;
  }

  const prefix = isTestnet ? CashAddressNetworkPrefix.testnet : CashAddressNetworkPrefix.mainnet;

  return encodeCashAddress(prefix, decoded.type as any, decoded.hash);
}

const depositWallet = await WalletClass.fromCashaddr(convertCashaddr("bitcoincash:qrsl56haj6kcw7v7lw9kzuh89v74maemqsq8h4rfqy"));
const receiptWallet = await WalletClass.fromCashaddr(convertCashaddr("bitcoincash:qqk49pam6ehhzen69ur9stzvnukhwm4mmc5l83anug"));

const uploadServiceUrl = isTestnet ? "http://localhost:8000/u/" : "https://ipfs.pat.mn/u/";

const paramTokenId = isTestnet ? "46a9cdaeb7f00c90896a874ecd093b0293fffa6521dbf676b0cacc39ddf791c3" : "9c909692e2dcc33150e8ddefb4ae4508b0780880773330d1fffd60cdb4cee6b1"

export default function Home() {
  const [url, setUrl] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [debouncedUrl] = useDebounce(url, 500);
  const [opReturnData, setOpReturnData] = useState<string>("");
  const [payString, setPayString] = useState<string>("");
  const [watchDepositCancel, setWatchDepositCancel] = useState<Function>();
  const [watchReceiptCancel, setWatchReceiptCancel] = useState<Function>();
  const [depositTx, setDepositTx] = useState<string>("");
  const [receiptTx, setReceiptTx] = useState<string>("");
  const [pinnedCID, setPinnedCID] = useState<string>("");
  const [showCode, setShowCode] = useState<boolean>(false);
  const [showRawData, setShowRawData] = useState<boolean>(false);
  const [rawData, setRawData] = useState<string>("");
  const [fee, setFee] = useState<number>(0);
  const [maxSize, setMaxSize] = useState<number>(0 * 1024);

  useEffect(() => {
    (async () => {
      const utxos = (await receiptWallet.getTokenUtxos(paramTokenId)).filter(val => val.token?.capability === NFTCapability.mutable);
      console.log(utxos)
      const commitment = utxos[0].token?.commitment;
      if (!commitment || commitment.length !== 16) {
        return;
      }

      const fee = binToNumberUint32LE(hexToBin(commitment.slice(0, 8)));
      const size = binToNumberUint32LE(hexToBin(commitment.slice(8)));
      setFee(fee);
      setMaxSize(size);
    })();
  }, []);

  const clear = useCallback(async () => {
    setUrl("");
    setError("");
    setPayString("");
    setDepositTx("");
    setReceiptTx("");
    setPinnedCID("");
    setShowRawData(false);
    setRawData("");
    if (watchDepositCancel) watchDepositCancel();
    if (watchReceiptCancel) watchReceiptCancel();
  }, [watchDepositCancel, watchReceiptCancel]);

  const upload = useCallback(async (fileOrRawData: string | File) => {
    let size = 0;
    const formData = new FormData();
    if (typeof fileOrRawData === "string") {
      size = fileOrRawData.length;
      formData.append("file", new Blob([rawData], {
        type: 'text/plain'
      }));
    } else {
      size = fileOrRawData.size;
      formData.append("file", fileOrRawData);
    }

    if (size > maxSize) {
      setError(`Raw data size exceeds ${maxSize/1024}kb (${Math.round(size/1024)}kb)`)
      return;
    }
    if (size === 0) {
      setError(`Empty data`);
      return;
    }
    setError("");

    try {
      const response = await axios.post(uploadServiceUrl, formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      const url = response.data?.url;
      if (url) {
        setUrl(url);
        setShowRawData(false);
        setRawData("");
      }
    } catch (e) {
      setError(`Error uploading file: ${(e as any)?.response?.data?.error}`);
    }
  }, [rawData, maxSize]);

  const fileSelected = useCallback(async (event) => {
    if (event.target.files?.[0]) {
      upload(event.target.files[0]).finally(() => event.target.value = "");
    }
  }, [upload]);

  useEffect(() => {
    const source = axios.CancelToken.source();
    if (debouncedUrl) {
      if (!isValidUrl(debouncedUrl)) {
        setError("Invalid URL");
        return;
      }
      if (debouncedUrl.length > 210) {
        setError(`URL length too long (${debouncedUrl.length}) to fit into OP_RETURN`);
        return;
      } else {
        setError("");
      }

      fetchUrl(debouncedUrl, source.token)
        .then((response) => {
          const remoteSize = parseInt(response.headers["content-length"]);
          if (remoteSize > maxSize) {
            setError(`Remote content exceeds ${maxSize/1024}kb (${Math.round(remoteSize/1024)} kb)`)
          }

          setError("");
          const data = OpReturnData.fromArray(["IPBC", "PIN", debouncedUrl]).buffer.toString("hex");
          setOpReturnData(data);
          setPayString(`${depositWallet.getDepositAddress()}?amount=${fee / 1e8}&op_return_raw=${data.slice(2)}`);
        })
        .catch((e) => {
          if (axios.isCancel(source)) {
            return;
          }
          setError("Error fetching URL");
        });
    } else {
      setUrl("");
    }
    return () => {
      source.cancel(
        "Canceled because of component unmounted or debounce Text changed"
      );
    };
  }, [debouncedUrl, fee, maxSize]);

  useEffect(() => {
    // if (watchDepositCancel) {
    //   watchDepositCancel();
    // }

    const depositCancel = depositWallet.watchAddressTransactions((tx) => {
      const depositDetected = tx.vout.filter(val => val.scriptPubKey.hex === opReturnData).length;
      if (depositDetected) {
        setDepositTx(tx.hash);
      }
    });
    // setWatchDepositCancel(() => depositCancel);
  }, [opReturnData, 
    // watchDepositCancel
  ]);

  useEffect(() => {
    if (!depositTx) {
      return;
    }
    // if (watchReceiptCancel) {
    //   watchReceiptCancel();
    // }

    // console.log(depositTx, receiptWallet)
    const receiptCancel = receiptWallet.watchAddressTransactions((tx) => {
      const opReturn = tx.vout.find(val => val.scriptPubKey.type === "nulldata")?.scriptPubKey.hex;
      if (!opReturn) {
        return;
      }
      const chunks = parseOpReturn(opReturn);
      if (chunks.length != 4 || binToUtf8(chunks[0]) !== "IPBC" || binToUtf8(chunks[2]) !== depositTx) {
        return;
      }

      if (binToUtf8(chunks[1]) === "REFUND") {
        const refundReason = binToUtf8(chunks[3]);
        switch (refundReason) {
          case "NOT_IPBC":
            setError(`Transaction refunded due to error: "Not an IPBC transaction"`);
            return;
          case "FEE_NOT_PAID":
            setError(`Transaction refunded due to error: "Did not pay required fee - ${fee / 1e8} BCH"`);
            return;
          case "DL_FAIL":
            setError(`Transaction refunded due to error: "Service was not able to download remote data and pin it"`);
            return;
        }
      } else if (binToUtf8(chunks[1]) === "DONE") {
        setReceiptTx(tx.hash);
        setPinnedCID(binToUtf8(chunks[3]));
      } else {
        setError(`Unknown receipt format ${chunks.map(binToUtf8).join(' ')}`)
      }
    });
    // setWatchReceiptCancel(() => receiptCancel);
  }, [depositTx,
    // watchReceiptCancel
  ]);

  return (
    <>
      <Head>
        <title>IPFS-BCH</title>
        <meta name="description" content="ipfs-bch is an IPFS file pinning service with on-chain settlement" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.main + "mt-10 lg:mt-0 p-[1rem] lg:p-[4rem]"}>
        <h1 className="flex justify-center mb-3 text-xl font-bold">IPFS-BCH</h1>
        <h2 className="flex justify-center mb-3 text-md font-bold">IPFS file pinning service with on-chain settlement</h2>

        <div className="flex flex-col justify-center">
          <div className="flex flex-row justify-center gap-3">
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="URL of a remote file to pin" type="text" className="form-control block w-full lg:w-7/12 px-3 py-1.5 text-base font-normal text-gray-700 bg-white bg-clip-padding border border-solid border-gray-300 rounded transition ease-in-out m-0 focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none"/>
            <button type="button" onClick={() => setShowRawData(!showRawData)} className="inline-block px-6 py-2.5 bg-gray-200 text-gray-700 font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-gray-300 hover:shadow-lg  active:bg-gray-400 active:shadow-lg transition duration-150 ease-in-out">Paste Raw Data</button>
            <button type="button" onClick={() => document.getElementById('fileInput')?.click()} className="inline-block px-6 py-2.5 bg-gray-200 text-gray-700 font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-gray-300 hover:shadow-lg  active:bg-gray-400 active:shadow-lg transition duration-150 ease-in-out">Upload local file</button>
            <input type="file" id="fileInput" className="hidden" onChange={fileSelected} />
            <button type="button" onClick={clear} className="inline-block px-6 py-2.5 bg-gray-200 text-gray-700 font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-gray-300 hover:shadow-lg  active:bg-gray-400 active:shadow-lg transition duration-150 ease-in-out">Clear</button>
          </div>
          {error.length > 0 && <div className="flex text-lg justify-center text-red-500">{error}</div>}
        </div>

        {error.length === 0 && payString.length > 0 &&
          <div className="flex flex-col mt-5 items-center">
            <div className="text-lg ">Tap, scan or copy the QR code and proceed to Electron-Cash</div>
            <div className="max-w-[200px]">
              <a href={payString}>
                <Image
                  src={qrAddress(payString).src}
                  title={payString}
                  alt={payString}
                  width={250}
                  height={250}
                />
              </a>
            </div>
            <span className="max-w-[600px] break-words break-all text-xs">{payString}</span>
          </div>
        }

        {showRawData &&
          <div className="mt-5 p-5 overflow-y-scroll border-black border-2 border-solid whitespace-pre-wrap h-[500px] font-mono text-sm">
            <textarea
              className="peer block min-h-[auto] h-4/5 w-full rounded border-0 bg-white py-[0.32rem] px-3 leading-[1.6]"
              onChange={(event) => setRawData(event.target.value)}
              value={rawData}
              placeholder="Raw data">
            </textarea>
            <div className="flex justify-center items-center gap-5 mt-7">
              <button type="button" onClick={() => upload(rawData)} className="inline-block px-6 py-2.5 bg-gray-200 text-gray-700 font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-gray-300 hover:shadow-lg  active:bg-gray-400 active:shadow-lg transition duration-150 ease-in-out">Save</button>
              <button type="button" onClick={() => { setRawData(""); setShowRawData(false); }} className="inline-block px-6 py-2.5 bg-gray-200 text-gray-700 font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-gray-300 hover:shadow-lg  active:bg-gray-400 active:shadow-lg transition duration-150 ease-in-out">Cancel</button>
            </div>
          </div>
        }


        {depositTx.length > 0 &&
          <div className="flex flex-col mt-5 items-center">
            <div className="text-lg ">{`Deposit transaction detected: `}
              <a target="_blank" rel="noreferrer" className="text-sky-700" href={`https://blockchair.com/bitcoin-cash/transaction/${depositTx}`}>{depositTx}</a>
            </div>
          </div>
        }
        {receiptTx.length > 0 &&
          <div className="flex flex-col mt-5 items-center gap-5">
            <div className="text-lg ">{`Receipt transaction detected: `}
              <a target="_blank" rel="noreferrer" className="text-sky-700" href={`https://blockchair.com/bitcoin-cash/transaction/${receiptTx}`}>{receiptTx}</a>
            </div>
            <div className="text-lg ">{`Your file is immediately available at: ` }
              <a target="_blank" rel="noreferrer" className="text-sky-700" href={`https://ipfs.pat.mn/ipfs/${pinnedCID}`}>{`https://ipfs.pat.mn/ipfs/${pinnedCID}`}</a>
            </div>
            <div className="text-lg ">{`It will be later available over other public gateways given enough requests will be made to it.`}
              <br />
              Examples:
              <br />
              <a target="_blank" rel="noreferrer" className="pl-5 text-sky-700" href={`https://ipfs.io/ipfs/${pinnedCID}`}>{`https://ipfs.io/ipfs/${pinnedCID}`}</a>
              <br />
              <a target="_blank" rel="noreferrer" className="pl-5 text-sky-700" href={`https://dweb.link/ipfs/${pinnedCID}`}>{`https://dweb.link/ipfs/${pinnedCID}`}</a>
            </div>
          </div>
        }

        <hr className="border-gray-900 mt-10" />

        <h2 className="flex justify-center mt-10 mb-1 text-md font-bold">WTH is IPFS-BCH?</h2>
        <div>
          IPFS-BCH allows to publish user content on IPFS with ease, in a permissionless fashion. No KYC or registartion needed.<br/>
          It is an ideal tool to upload your <a target="_blank" rel="noreferrer" className="pl-1 text-sky-700" href={`https://github.com/bitjson/chip-bcmr`}>BCMR</a> data and use it in your applications.<br/>
          <br/>
          This service is in beta and provided to you as is without any liability for lost funds. <br/>
          Current fee rate for file upload is { fee/1e8 } BCH, max file size is {maxSize/1024}kb. <br/>
          Only one file can be uploaded at a time. <br />
          In case the service receives a malformed transaction, excessive file size or insufficient funds, you will be refunded. <br/>
          If you send excessive funds over the fee limit, you will receive your change back. <br/>
        </div>

        <h2 className="flex justify-center mt-10 mb-1 text-md font-bold">How does it work?</h2>
        <div>
          One needs to send a simple Bitcoin Cash transaction to this service&#39;s deposit address.<br />
          The transaction must pay a pinning fee and specify the URL of a remote file which needs to be pinned on IPFS using an OP_RETURN output.<br />
          The OP_RETURN format is the following: <pre className="inline font-semibold">{`<'IPBC'> <'PIN'> <'URL'>`}</pre>, where <pre className="inline font-semibold">{`<>`}</pre> denotes a data chunk pushed to bitcoin VM stack.<br />
          The IPFS-BCH service constantly monitors the deposit address and upon arrival of a pin request transaction will download the remote file and upload it to IPFS.<br />
          It will then send a transaction to the reciept address, with one output being an OP_RETURN in the following format: <pre className="inline font-semibold">{`<'IPBC'> <'DONE'> <'TXID'> <'CID'>`}</pre>.<br />
          The <pre className="inline font-semibold">TXID</pre> here is the hash of the deposit transaction. This field allows to link the deposit and receipt transactions.<br />
          The <pre className="inline font-semibold">CID</pre> field is the <a target="_blank" rel="noreferrer" className="pl-1 text-sky-700" href={`https://docs.ipfs.tech/concepts/content-addressing/`}>content identifier</a> of the uploaded file on the IPFS.<br />
        </div>

        <div className="flex flex-col mt-5 items-center mb-5">
          <div className="text-lg ">Pinning files on IPFS can be easily scripted in your workflows using
            <a target="_blank" rel="noreferrer" className="pl-2 text-sky-700" href={`https://mainnet.cash`}>{`mainnet.cash`}</a>
            <button type="button" onClick={() => setShowCode(!showCode)} className="ml-5 inline-block px-6 py-2.5 bg-gray-200 text-gray-700 font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-gray-300 hover:shadow-lg  active:bg-gray-400 active:shadow-lg transition duration-150 ease-in-out">Show Code</button>
          </div>
        </div>
        {showCode && <SyntaxHighlighter language="javascript" style={githubGist}>
          {exampleCode}
        </SyntaxHighlighter>}

        <hr className="border-gray-900 mt-10" />

        <div className="flex flex-col mt-10 items-center">
          <div className="text-lg ">Do you like IPFS-BCH? Tips are welcome!</div>
          <div className="max-w-[200px]">
            <a href="bitcoincash:qqsxjha225lmnuedy6hzlgpwqn0fd77dfq73p60wwp?amount=0.1337">
              <Image
                src="./qr.svg"
                title="bitcoincash:qqsxjha225lmnuedy6hzlgpwqn0fd77dfq73p60wwp"
                alt="bitcoincash:qqsxjha225lmnuedy6hzlgpwqn0fd77dfq73p60wwp"
                width={150}
                height={150}
              />
            </a>
          </div>
          <div>pat#111222; 🎀</div>
          <span className="flex flex-row"><span className="hidden lg:block">bitcoincash:</span>qqsxjha225lmnuedy6hzlgpwqn0fd77dfq73p60wwp</span>
        </div>
      </main>
    </>
  )
}

const parseOpReturn = (opReturnHex: string): Uint8Array[] => {
  const opReturn = hexToBin(opReturnHex);
  const chunks: Uint8Array[] = [];
  let position = 1;

  // handle direct push, OP_PUSHDATA1, OP_PUSHDATA2;
  // OP_PUSHDATA4 is not supported in OP_RETURNs by consensus
  while (opReturn[position]) {
    let length = 0;
    if (opReturn[position] === 0x4c) {
      length = opReturn[position + 1];
      position += 2;
    } else if (opReturn[position] === 0x4d) {
      length = binToNumberUint16LE(
        opReturn.slice(position + 1, position + 3)
      );
      position += 3;
    } else {
      length = opReturn[position];
      position += 1;
    }

    chunks.push(opReturn.slice(position, position + length));
    position += length;
  }

  return chunks;
}

const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch (err) {
    return false;
  }
}

const fetchUrl = (url, token) => {
  return axios
    .head(url, {
      cancelToken: token,
      headers: {  }
    })
}

const exampleCode = `
// deposit transaction to monitor, will be set later
let depositTx;

// create a mainnet Wallet instance to monitor file upload receipts
const receiptWallet = await Wallet.watchOnly("bitcoincash:qqk49pam6ehhzen69ur9stzvnukhwm4mmc5l83anug");

// set up file upload monitoring
receiptWallet.watchAddressTransactions((tx) => {
  // find OP_RETURN data
  const opReturn = tx.vout.find(val => val.scriptPubKey.type === "nulldata")?.scriptPubKey.hex;
  if (!opReturn) {
    return;
  }

  // parse OP_RETURN, do sanity checks and ensure the arrived receipt is for our deposit transaction
  const chunks = OpReturnData.parse(opReturn);
  if (chunks.length !== 4 || chunks[0] !== "IPBC" || chunks[2] !== depositTx) {
    return;
  }

  const ipfsCID = chunks[3];

  // your code here
  console.log(ipfsCID);
});

// create a mainnet Wallet instance from WIF, assuming it was exported to system environment
const wallet = await Wallet.fromId(
  \`wif:mainnet:\${process.env.PRIVATE_WIF!}\`
);

// send pin request alongside with payment
const response = await wallet.send([
  OpReturnData.fromArray(["IPBC", "PIN", "https://gist.githubusercontent.com/mr-zwets/91caf52be18a94ba0afa93823e890bc9/raw"]),
  {cashaddr: "bitcoincash:qrsl56haj6kcw7v7lw9kzuh89v74maemqsq8h4rfqy", value: 0.0025, unit: "bch"},
]);

// update deposit transaction hash here so that it will be used in receipt monitoring
depositTx = response.txId;
  `;
