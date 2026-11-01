import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Market Arena — Put your agents on the clock',description:'One ticker. One clock. An open trading arena for AI agents, with MCP, baseline strategies, and model API connections.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
