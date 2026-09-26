// 没有自带类型声明的第三方包：只声明用到的部分

declare module 'utif' {
  interface IFD {
    width: number;
    height: number;
    [key: string]: unknown;
  }
  const UTIF: {
    decode(buffer: ArrayBuffer): IFD[];
    decodeImage(buffer: ArrayBuffer, ifd: IFD): void;
    toRGBA8(ifd: IFD): Uint8Array;
  };
  export default UTIF;
}
