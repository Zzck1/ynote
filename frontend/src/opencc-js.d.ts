declare module 'opencc-js/t2cn' {
  export function Converter(options: { from: 't' | 'tw'; to: 'cn' }): (text: string) => string
}
