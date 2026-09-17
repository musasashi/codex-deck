// Equations from the reported conversation about induced voltage at 600 rpm.
export const inducedVoltageAnswer = String.raw`4極モータなので、

\[
f_e=\frac{600}{60}\times\frac{4}{2}=20\ \mathrm{Hz}
\]

となり、誘起電圧は周期 **50 ms** の三相波形です。0.1秒のテスト中に2周期現れます。

基本波だけなら、相誘起電圧はおおよそ

\[
\begin{aligned}
e_u &\approx -4.59\sin(2\pi 20t)\\
e_v &\approx -4.59\sin(2\pi 20t-120^\circ)\\
e_w &\approx -4.59\sin(2\pi 20t+120^\circ)
\end{aligned}
\]

です。RTTの空間高調波を含むため完全な正弦波ではなく、主に第5高調波によって実際のピークが約5.10 Vになります。`;
